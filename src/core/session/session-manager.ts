import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SeptumRepository } from "../database/repository.ts";
import type { ActiveFeatureSession } from "../../types/index.ts";
import { SeptumDatabase } from "../database/client.ts";

export class SessionManager {
  private static readonly SESSION_FILE = ".septum/session.json";

  public static getOwnerId(): string {
    return process.env.SEPTUM_SESSION_ID || `process:${process.pid}`;
  }

  public static isOwnerAlive(ownerId?: string): boolean {
    if (!ownerId) return false;
    const match = ownerId.match(/^process:(\d+)$/);
    if (!match) {
      // If it's a custom SEPTUM_SESSION_ID or UUID, we cannot inspect OS PID; treat as active.
      return true;
    }
    const pid = parseInt(match[1], 10);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error?.code === "EPERM";
    }
  }

  private static mutate<T>(workspaceRoot: string, fn: () => T, repo?: SeptumRepository): T {
    if (repo) return repo.runInTransaction(fn, true);
    const db = new SeptumDatabase(join(workspaceRoot, ".septum/septum.db"));
    try {
      // Serialize ownership checks with writes across CLI and MCP processes.
      return db.raw.transaction(fn).immediate();
    } finally {
      db.close();
    }
  }

  public static saveActiveSession(
    workspaceRoot: string,
    session: ActiveFeatureSession,
    ownerId: string = SessionManager.getOwnerId(),
    persistence?: { repo: SeptumRepository; save: () => void }
  ): void {
    SessionManager.mutate(workspaceRoot, () => {
      const current = SessionManager.getActiveSession(workspaceRoot);
      if (current && current.owner_id !== ownerId) {
        if (SessionManager.isOwnerAlive(current.owner_id)) {
          throw new Error(`Workspace already has an active feature session owned by '${current.owner_id || "legacy-session"}'. Release it with its owner, or explicitly run 'septum feature clear --force'.`);
        }
      }
      const septumDir = join(workspaceRoot, ".septum");
      mkdirSync(septumDir, { recursive: true });
      const sessionPath = join(workspaceRoot, SessionManager.SESSION_FILE);
      const temporaryPath = `${sessionPath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, JSON.stringify({ ...session, owner_id: ownerId }, null, 2), "utf-8");
        // Metadata and ownership use one write lock; a failed rename rolls back SQLite.
        persistence?.save();
        renameSync(temporaryPath, sessionPath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    }, persistence?.repo);
  }

  public static getActiveSession(workspaceRoot: string): ActiveFeatureSession | null {
    const sessionPath = join(workspaceRoot, SessionManager.SESSION_FILE);
    if (!existsSync(sessionPath)) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(sessionPath, "utf-8")) as ActiveFeatureSession;
    } catch (e: any) {
      throw new Error(`Corrupted active feature session JSON in '${sessionPath}': ${e.message}. Release it explicitly with 'septum feature clear --force' or 'septum_feature({action: "release", force: true})'.`);
    }
    if (parsed && typeof parsed.feature_key === "string" && parsed.feature_key.trim() &&
        typeof parsed.domain === "string" && parsed.domain.trim() &&
        Array.isArray(parsed.touchpoints) && parsed.touchpoints.every((tp: unknown) => typeof tp === "string") &&
        (parsed.owner_id === undefined || typeof parsed.owner_id === "string")) return parsed;
    throw new Error(`Invalid active feature session in '${sessionPath}'. Release it explicitly with 'septum feature clear --force'.`);
  }

  public static clearActiveSession(
    workspaceRoot: string,
    ownerId: string = SessionManager.getOwnerId(),
    force: boolean = false
  ): boolean {
    if (!existsSync(join(workspaceRoot, SessionManager.SESSION_FILE))) return false;
    return SessionManager.mutate(workspaceRoot, () => {
      const sessionPath = join(workspaceRoot, SessionManager.SESSION_FILE);
      if (!existsSync(sessionPath)) return false;
      if (!force) {
        const current = SessionManager.getActiveSession(workspaceRoot);
        if (current?.owner_id && current.owner_id !== ownerId) {
          if (SessionManager.isOwnerAlive(current.owner_id)) {
            throw new Error("Only the active session owner can release it. Use 'septum feature clear --force' for explicit recovery.");
          }
        }
      }
      rmSync(sessionPath, { force: true });
      return true;
    });
  }
}
