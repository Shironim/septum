import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installGitHook } from "../../src/cli/commands/init.ts";
import { handleCheckCommand } from "../../src/cli/commands/check.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";

describe("F2-08: Readiness, Hook Status & Enforcement Diagnostics", () => {
  it("should accurately report skipped hook on non-git workspace", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-f208-nogit-"));
    try {
      const hookResult = installGitHook(tmpDir, false);
      expect(hookResult.status).toBe("skipped_no_git");
      expect(hookResult.message).toContain("No .git directory found");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should distinguish audit-only vs blocking enforcement mode from repository config", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-f208-enforce-"));
    const dbPath = path.join(tmpDir, ".septum", "septum.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    try {
      const db = new SeptumDatabase(dbPath);
      const repo = new SeptumRepository(db.raw);

      // Default enforcement is "warn"
      const defaultConfig = ConfigLoader.loadFromRepository(repo);
      expect(defaultConfig.settings.enforcement).toBe("warn");

      // Set enforcement to "strict"
      repo.setMeta("settings_json", JSON.stringify({ enforcement: "strict" }));
      const strictConfig = ConfigLoader.loadFromRepository(repo);
      expect(strictConfig.settings.enforcement).toBe("strict");

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should distinguish partial coverage from full coverage based on persisted metadata", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-f208-coverage-"));
    const dbPath = path.join(tmpDir, ".septum", "septum.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    try {
      const db = new SeptumDatabase(dbPath);
      const repo = new SeptumRepository(db.raw);

      // 1. Clean state: no unsupported or skipped files
      repo.setMeta("unsupported_files", JSON.stringify([]));
      repo.setMeta("skipped_files", JSON.stringify([]));

      const unsupp1 = JSON.parse(repo.getMeta("unsupported_files") || "[]");
      const skip1 = JSON.parse(repo.getMeta("skipped_files") || "[]");
      expect(unsupp1.length + skip1.length).toBe(0);

      // 2. Partial state: has unsupported files or oversized files
      repo.setMeta("unsupported_files", JSON.stringify(["src/engine.rs"]));
      repo.setMeta(
        "skipped_files",
        JSON.stringify([{ path: "src/big_bundle.js", reason: "file_too_large" }])
      );

      const unsupp2 = JSON.parse(repo.getMeta("unsupported_files") || "[]");
      const skip2 = JSON.parse(repo.getMeta("skipped_files") || "[]");
      expect(unsupp2).toContain("src/engine.rs");
      expect(skip2).toHaveLength(1);
      expect(skip2[0].path).toBe("src/big_bundle.js");

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should verify commit rejection behavior: warn exits 0 (advisory), strict exits 1 (blocking)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-f208-rejection-"));
    const origCwd = process.cwd();
    const origExitCode = process.exitCode;

    try {
      process.chdir(tmpDir);

      // Create git repo
      const gitDir = path.join(tmpDir, ".git");
      fs.mkdirSync(gitDir, { recursive: true });

      // Create DB and domains: domain A forbidden to depend on domain B
      const dbDir = path.join(tmpDir, ".septum");
      fs.mkdirSync(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, "septum.db");
      const db = new SeptumDatabase(dbPath);
      const repo = new SeptumRepository(db.raw);

      repo.upsertDomain("billing", {
        root: "src/billing",
        allowed_dependencies: [],
        forbidden_dependencies: ["auth"],
        archetypes: {},
      });
      repo.upsertDomain("auth", {
        root: "src/auth",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {},
      });

      // 1. Test in default warn mode: exitCode should NOT be set to 1
      process.exitCode = 0;
      repo.setMeta("settings_json", JSON.stringify({ enforcement: "warn" }));
      db.close();

      // In check with strict=false, violations log warnings but do not fail process
      // We test handleCheckCommand with strict=false
      await handleCheckCommand({ staged: false, strict: false });
      expect(process.exitCode).toBe(0);

      // 2. Test in strict mode: exitCode MUST be set to 1 to block commits
      process.exitCode = 0;
      const dbStrict = new SeptumDatabase(dbPath);
      const repoStrict = new SeptumRepository(dbStrict.raw);
      repoStrict.setMeta("settings_json", JSON.stringify({ enforcement: "strict" }));
      dbStrict.close();

      // Create violating import between billing and auth
      fs.mkdirSync(path.join(tmpDir, "src/auth"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src/auth/service.ts"), "export class AuthService {}\n");
      fs.mkdirSync(path.join(tmpDir, "src/billing"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src/billing/service.ts"), "import { AuthService } from '../auth/service.ts';\nexport class BillingService {}\n");

      // Run with strict=true
      await handleCheckCommand({ staged: false, strict: true });
      // When strict is enabled and violations or unindexed files occur, exitCode is 1
      expect(process.exitCode).toBe(1);
    } finally {
      // Bun keeps a previous nonzero value when assigned undefined.
      process.exitCode = origExitCode ?? 0;
      process.chdir(origCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

