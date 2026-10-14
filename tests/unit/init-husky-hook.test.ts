import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { installGitHook } from "../../src/cli/commands/init.ts";

describe("F2-03: Husky Hook Runner Selection and Exit Code Propagation", () => {
  it("should create executable .husky/pre-commit when not present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-husky-fresh-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, ".husky"), { recursive: true });

      const result = installGitHook(tmpDir, false);
      const hookPath = path.join(tmpDir, ".husky", "pre-commit");

      expect(fs.existsSync(hookPath)).toBe(true);
      expect(result.status).toBe("installed");
      const stat = fs.statSync(hookPath);
      expect(stat.mode & 0o777).toBe(0o755);
      const content = fs.readFileSync(hookPath, "utf-8");
      expect(content).toContain("septum check --staged");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should append to existing user Husky hook without duplicate on repeat", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-husky-repeat-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, ".husky"), { recursive: true });

      const hookPath = path.join(tmpDir, ".husky", "pre-commit");
      fs.writeFileSync(hookPath, "#!/bin/sh\necho USER_HUSKY_HOOK\n", { mode: 0o755 });

      // First run: append
      const res1 = installGitHook(tmpDir, false);
      expect(res1.status).toBe("updated");
      const content1 = fs.readFileSync(hookPath, "utf-8");
      expect(content1).toContain("USER_HUSKY_HOOK");
      expect(content1).toContain("septum check --staged");

      // Count occurrences of "septum check --staged"
      const occurrences1 = (content1.match(/septum check --staged/g) || []).length;
      expect(occurrences1).toBeGreaterThanOrEqual(1);

      // Second run: should be already_installed and not duplicate
      const res2 = installGitHook(tmpDir, false);
      expect(res2.status).toBe("already_installed");
      const content2 = fs.readFileSync(hookPath, "utf-8");
      const occurrences2 = (content2.match(/septum check --staged/g) || []).length;
      expect(occurrences2).toBe(occurrences1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should propagate non-zero checker exit code and NOT fall back when checker exits non-zero", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-husky-exit-"));
    try {
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, ".husky"), { recursive: true });

      const hookPath = path.join(tmpDir, ".husky", "pre-commit");
      fs.writeFileSync(hookPath, "#!/bin/sh\necho USER_HUSKY_HOOK\n", { mode: 0o755 });

      installGitHook(tmpDir, false);

      // Create fake runtimes:
      // global 'septum' exits 1 (rejection)
      // local './node_modules/.bin/septum' exits 0 (success)
      const fakeBinDir = path.join(tmpDir, "fake-bin");
      const logFile = path.join(tmpDir, "invocations.log");
      fs.mkdirSync(fakeBinDir, { recursive: true });

      const fakeGlobalSeptum = path.join(fakeBinDir, "septum");
      fs.writeFileSync(
        fakeGlobalSeptum,
        `#!/bin/sh\nprintf "global:%s\\n" "$*" >> "${logFile}"\nexit 1\n`,
        { mode: 0o755 }
      );

      const localBinDir = path.join(tmpDir, "node_modules", ".bin");
      fs.mkdirSync(localBinDir, { recursive: true });
      const fakeLocalSeptum = path.join(localBinDir, "septum");
      fs.writeFileSync(
        fakeLocalSeptum,
        `#!/bin/sh\nprintf "local:%s\\n" "$*" >> "${logFile}"\nexit 0\n`,
        { mode: 0o755 }
      );

      // Execute .husky/pre-commit with PATH pointing to fakeBinDir
      const env = {
        ...process.env,
        PATH: `${fakeBinDir}:/usr/bin:/bin`,
      };

      const proc = spawnSync("sh", [hookPath], {
        cwd: tmpDir,
        env,
        encoding: "utf-8",
      });

      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "";

      // Rejection MUST propagate as exit non-zero (exit code 1)
      expect(proc.status).toBe(1);

      // Global runner was executed
      expect(log).toContain("global:check --staged");

      // Local runner must NOT have been executed as a fallback!
      expect(log).not.toContain("local:check --staged");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
