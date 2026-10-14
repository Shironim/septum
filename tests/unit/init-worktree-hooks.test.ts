import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { installGitHook } from "../../src/cli/commands/init.ts";

describe("F2-04: Git Hook Resolution for Worktrees and custom core.hooksPath", () => {
  it("should resolve hooks directory and install pre-commit hook in a linked worktree", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "septum-wt-test-"));
    try {
      const mainRepo = path.join(tmpBase, "main");
      fs.mkdirSync(mainRepo, { recursive: true });
      execFileSync("git", ["init"], { cwd: mainRepo, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainRepo, stdio: "ignore" });
      fs.writeFileSync(path.join(mainRepo, "init.txt"), "hello", "utf-8");
      execFileSync("git", ["add", "init.txt"], { cwd: mainRepo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: mainRepo, stdio: "ignore" });

      const wtRepo = path.join(tmpBase, "linked-wt");
      execFileSync("git", ["worktree", "add", wtRepo, "HEAD"], { cwd: mainRepo, stdio: "ignore" });

      // In linked worktree, .git is a file, not a directory
      expect(fs.statSync(path.join(wtRepo, ".git")).isFile()).toBe(true);

      // installGitHook should not throw ENOTDIR
      const result = installGitHook(wtRepo, false);
      expect(result.status).toBe("installed");
      expect(result.path).toBeDefined();
      expect(fs.existsSync(result.path!)).toBe(true);
      const hookContent = fs.readFileSync(result.path!, "utf-8");
      expect(hookContent).toContain("Septum deterministic boundary pre-commit hook");

      // Repeat should report already_installed
      const repeatResult = installGitHook(wtRepo, false);
      expect(repeatResult.status).toBe("already_installed");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("should preserve existing user hook in main repo when installing in linked worktree", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "septum-wt-preserve-"));
    try {
      const mainRepo = path.join(tmpBase, "main");
      fs.mkdirSync(mainRepo, { recursive: true });
      execFileSync("git", ["init"], { cwd: mainRepo, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: mainRepo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: mainRepo, stdio: "ignore" });
      fs.writeFileSync(path.join(mainRepo, "init.txt"), "hello", "utf-8");
      execFileSync("git", ["add", "init.txt"], { cwd: mainRepo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: mainRepo, stdio: "ignore" });

      // Place user hook in main repo
      const mainHookPath = path.join(mainRepo, ".git", "hooks", "pre-commit");
      fs.mkdirSync(path.dirname(mainHookPath), { recursive: true });
      const userHookScript = "#!/bin/sh\necho USER_WORKTREE_HOOK\nexit 11\n";
      fs.writeFileSync(mainHookPath, userHookScript, { mode: 0o755, encoding: "utf-8" });

      const wtRepo = path.join(tmpBase, "linked-wt");
      execFileSync("git", ["worktree", "add", wtRepo, "HEAD"], { cwd: mainRepo, stdio: "ignore" });

      const result = installGitHook(wtRepo, false);
      expect(result.status).toBe("preserved_user_hook");
      expect(fs.readFileSync(mainHookPath, "utf-8")).toBe(userHookScript);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("should preserve user hook and not install to .git/hooks when core.hooksPath is configured", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-custom-hooks-"));
    try {
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["config", "core.hooksPath", ".custom-hooks"], { cwd: tmpDir, stdio: "ignore" });

      const customHooksDir = path.join(tmpDir, ".custom-hooks");
      fs.mkdirSync(customHooksDir, { recursive: true });
      const customHook = path.join(customHooksDir, "pre-commit");
      const userHookContent = "#!/bin/sh\necho ACTIVE_USER_HOOK\n";
      fs.writeFileSync(customHook, userHookContent, { mode: 0o755, encoding: "utf-8" });

      const result = installGitHook(tmpDir, false);
      expect(result.status).toBe("preserved_user_hook");
      expect(result.path).toBe(customHook);
      expect(fs.readFileSync(customHook, "utf-8")).toBe(userHookContent);

      // Should not have written to .git/hooks/pre-commit
      const defaultHook = path.join(tmpDir, ".git", "hooks", "pre-commit");
      expect(fs.existsSync(defaultHook)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should install hook into custom core.hooksPath directory when empty", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-custom-fresh-"));
    try {
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
      execFileSync("git", ["config", "core.hooksPath", ".my-hooks"], { cwd: tmpDir, stdio: "ignore" });

      const customHook = path.join(tmpDir, ".my-hooks", "pre-commit");
      const result = installGitHook(tmpDir, false);

      expect(result.status).toBe("installed");
      expect(result.path).toBe(customHook);
      expect(fs.existsSync(customHook)).toBe(true);
      const content = fs.readFileSync(customHook, "utf-8");
      expect(content).toContain("Septum deterministic boundary pre-commit hook");

      // Should not have written to .git/hooks/pre-commit
      const defaultHook = path.join(tmpDir, ".git", "hooks", "pre-commit");
      expect(fs.existsSync(defaultHook)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
