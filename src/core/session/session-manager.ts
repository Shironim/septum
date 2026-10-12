import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ActiveFeatureSession } from "../../types/index.ts";
import { SeptumDatabase } from "../database/client.ts";

export class SessionManager {
  private static readonly SESSION_FILE = ".septum/session.json";

  public static getOwnerId(): string {
    return process.env.SEPTUM_SESSION_ID || `process:${process.pid}`;
  }

  private static mutate<T>(workspaceRoot: string, fn: () => T): T {
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
    ownerId: string = SessionManager.getOwnerId()
  ): void {
    SessionManager.mutate(workspaceRoot, () => {
      const current = SessionManager.getActiveSession(workspaceRoot);
      if (current && current.owner_id !== ownerId) {
        throw new Error(`Workspace already has an active feature session owned by '${current.owner_id || "legacy-session"}'. Release it with its owner, or explicitly run 'septum feature clear --force'.`);
      }
      const septumDir = join(workspaceRoot, ".septum");
      mkdirSync(septumDir, { recursive: true });
      const sessionPath = join(workspaceRoot, SessionManager.SESSION_FILE);
      const temporaryPath = `${sessionPath}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, JSON.stringify({ ...session, owner_id: ownerId }, null, 2), "utf-8");
        renameSync(temporaryPath, sessionPath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    });
  }

  public static getActiveSession(workspaceRoot: string): ActiveFeatureSession | null {
    const sessionPath = join(workspaceRoot, SessionManager.SESSION_FILE);
    if (!existsSync(sessionPath)) return null;
    const parsed = JSON.parse(readFileSync(sessionPath, "utf-8")) as ActiveFeatureSession;
    if (parsed && typeof parsed.feature_key === "string" && typeof parsed.domain === "string" && Array.isArray(parsed.touchpoints)) return parsed;
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
        if (current?.owner_id !== ownerId) throw new Error("Only the active session owner can release it. Use 'septum feature clear --force' for explicit recovery.");
      }
      rmSync(sessionPath);
      return true;
    });
  }
}
