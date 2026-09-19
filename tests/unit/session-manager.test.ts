import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { SessionManager } from "../../src/core/session/session-manager.ts";
import {
  handleClearFeatureContext,
  handleGetFeatureContext,
} from "../../src/mcp/tools/get-feature-context.ts";

describe("Active Feature Session Manager", () => {
  const testDir = join(import.meta.dir, "../fixtures/session_test");
  const dbPath = join(testDir, "test.db");
  let db: SeptumDatabase;
  let repo: SeptumRepository;

  const mockConfig: ValidatedSeptumConfig = {
    version: "1.0",
    settings: {
      enforcement: "strict",
      db_path: dbPath,
    },
    domains: {
      auth: {
        root: "src/auth",
      },
    },
    features: {
      login_flow: {
        domain: "auth",
        description: "User authentication flow",
        allowed_touchpoints: ["src/auth/LoginController.ts", "src/auth/AuthService.ts"],
        reuse_symbols: ["AuthService"],
        input_contract: {},
        output_contract: {},
      },
    },
  };

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    db = new SeptumDatabase(dbPath);
    repo = new SeptumRepository(db.raw);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("saves, retrieves, and clears active session correctly", () => {
    expect(SessionManager.getActiveSession(testDir)).toBeNull();

    SessionManager.saveActiveSession(testDir, {
      feature_key: "login_flow",
      domain: "auth",
      touchpoints: ["src/auth/LoginController.ts"],
      locked_at: new Date().toISOString(),
    });

    const active = SessionManager.getActiveSession(testDir);
    expect(active).not.toBeNull();
    expect(active?.feature_key).toBe("login_flow");
    expect(active?.domain).toBe("auth");
    expect(active?.touchpoints).toContain("src/auth/LoginController.ts");

    const cleared = SessionManager.clearActiveSession(testDir);
    expect(cleared).toBe(true);
    expect(SessionManager.getActiveSession(testDir)).toBeNull();
  });

  it("handleGetFeatureContext automatically sets session lease and clear releases it", () => {
    // Override cwd temporarily for the test
    const originalCwd = process.cwd;
    process.cwd = () => testDir;

    try {
      const res = handleGetFeatureContext(repo, mockConfig, { feature: "login_flow" });
      const payload = JSON.parse(res.content[0].text);
      expect(payload.feature).toBe("login_flow");

      const session = SessionManager.getActiveSession(testDir);
      expect(session).not.toBeNull();
      expect(session?.feature_key).toBe("login_flow");
      expect(session?.touchpoints).toContain("src/auth/LoginController.ts");

      const cleared = handleClearFeatureContext(testDir);
      expect(cleared).toBe(true);
      expect(SessionManager.getActiveSession(testDir)).toBeNull();
    } finally {
      process.cwd = originalCwd;
    }
  });
});
