import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installGitHook } from "../../src/cli/commands/init.ts";

describe("F2-01: Git Hook Preservation on Init", () => {
  it("should create fresh pre-commit hook when no hook exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-hook-fresh-"));
    try {
      const gitDir = path.join(tmpDir, ".git");
      fs.mkdirSync(gitDir, { recursive: true });

      const result = installGitHook(tmpDir, false);
      const hookPath = path.join(gitDir, "hooks", "pre-commit");

      expect(fs.existsSync(hookPath)).toBe(true);
      const content = fs.readFileSync(hookPath, "utf-8");
      expect(content).toContain("Septum deterministic boundary pre-commit hook");
      expect(content).toContain("septum check --staged");
      expect(result?.status).toBe("installed");
      const stat = fs.statSync(hookPath);
      expect(stat.mode & 0o777).toBe(0o755);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should preserve existing non-Septum user hook bytes and mode on init without force", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-hook-user-"));
    try {
      const gitDir = path.join(tmpDir, ".git");
      const hooksDir = path.join(gitDir, "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      const userHookContent = "#!/bin/sh\necho USER_EXISTING_CHECK\nexit 23\n";
      const hookPath = path.join(hooksDir, "pre-commit");
      fs.writeFileSync(hookPath, userHookContent, { mode: 0o755, encoding: "utf-8" });

      const result = installGitHook(tmpDir, false);

      expect(fs.existsSync(hookPath)).toBe(true);
      const contentAfter = fs.readFileSync(hookPath, "utf-8");
      expect(contentAfter).toBe(userHookContent);
      const stat = fs.statSync(hookPath);
      expect(stat.mode & 0o777).toBe(0o755);
      expect(result?.status).toBe("preserved_user_hook");
      expect(contentAfter).not.toContain("septum check --staged");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should preserve existing non-Septum user hook bytes and mode even with --force", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-hook-force-"));
    try {
      const gitDir = path.join(tmpDir, ".git");
      const hooksDir = path.join(gitDir, "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      const userHookContent = "#!/usr/bin/env python3\nimport sys\nprint('Python custom hook')\nsys.exit(0)\n";
      const hookPath = path.join(hooksDir, "pre-commit");
      fs.writeFileSync(hookPath, userHookContent, { mode: 0o700, encoding: "utf-8" });

      const result = installGitHook(tmpDir, true);

      expect(fs.existsSync(hookPath)).toBe(true);
      const contentAfter = fs.readFileSync(hookPath, "utf-8");
      expect(contentAfter).toBe(userHookContent);
      const stat = fs.statSync(hookPath);
      expect(stat.mode & 0o777).toBe(0o700);
      expect(result?.status).toBe("preserved_user_hook");
      expect(contentAfter).not.toContain("septum check --staged");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should update or keep existing Septum hook without conflict", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-hook-existing-septum-"));
    try {
      const gitDir = path.join(tmpDir, ".git");
      const hooksDir = path.join(gitDir, "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      const oldSeptumHook = `#!/usr/bin/env sh
# Septum deterministic boundary pre-commit hook
echo "old hook"
septum check --staged
`;
      const hookPath = path.join(hooksDir, "pre-commit");
      fs.writeFileSync(hookPath, oldSeptumHook, { mode: 0o755, encoding: "utf-8" });

      const result = installGitHook(tmpDir, false);

      expect(fs.existsSync(hookPath)).toBe(true);
      const contentAfter = fs.readFileSync(hookPath, "utf-8");
      expect(contentAfter).toContain("septum check --staged");
      expect(["already_installed", "updated"]).toContain(result?.status);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should return skipped_no_git when .git directory is absent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-hook-nogit-"));
    try {
      const result = installGitHook(tmpDir, false);
      expect(result?.status).toBe("skipped_no_git");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
