import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActiveFeatureSession } from "../../types/index.ts";

export class SessionManager {
  private static readonly SESSION_FILE = ".septum/session.json";

  /**
   * Save the active feature session to .septum/session.json
   */
  public static saveActiveSession(workspaceRoot: string, session: ActiveFeatureSession): void {
    const septumDir = join(workspaceRoot, ".septum");
    if (!existsSync(septumDir)) {
      mkdirSync(septumDir, { recursive: true });
    }
    const sessionPath = join(workspaceRoot, SessionManager.SESSION_FILE);
    writeFileSync(sessionPath, JSON.stringify(session, null, 2), "utf-8");
  }

  /**
   * Get the active feature session, or null if no session exists or file is invalid
   */
  public static getActiveSession(workspaceRoot: string): ActiveFeatureSession | null {
    const sessionPath = join(workspaceRoot, SessionManager.SESSION_FILE);
    if (!existsSync(sessionPath)) {
      return null;
    }

    try {
      const raw = readFileSync(sessionPath, "utf-8");
      const parsed = JSON.parse(raw) as ActiveFeatureSession;
      if (parsed && typeof parsed.feature_key === "string" && Array.isArray(parsed.touchpoints)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Clear the active feature session
   */
  public static clearActiveSession(workspaceRoot: string): boolean {
    const sessionPath = join(workspaceRoot, SessionManager.SESSION_FILE);
    if (existsSync(sessionPath)) {
      try {
        rmSync(sessionPath, { force: true });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
