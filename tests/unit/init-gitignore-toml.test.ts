import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureGitIgnore } from "../../src/cli/commands/init.ts";
import {
  appendTomlMcpServer,
  configureHarness,
} from "../../src/cli/scaffold/harness-config.ts";

describe("F2-09: Gitignore Active Ignore Lines Detection", () => {
  it("should add active ignore rules when .gitignore only contains commented references", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-f209-commented-"));
    try {
      const gitignorePath = path.join(tmpDir, ".gitignore");
      const commentedContent = `# This project uses Septum\n# Notice: .septum/ and .septum/*.db* store local SQLite cache\nnode_modules/\n*.log\n`;
      fs.writeFileSync(gitignorePath, commentedContent, "utf-8");

      ensureGitIgnore(tmpDir);

      const contentAfter = fs.readFileSync(gitignorePath, "utf-8");
      // Must preserve existing comments and rules
      expect(contentAfter).toContain("# Notice: .septum/ and .septum/*.db*");
      expect(contentAfter).toContain("node_modules/");
      expect(contentAfter).toContain("*.log");

      // Must have active ignore rules as separate non-comment lines
      const lines = contentAfter.split(/\r?\n/).map((l) => l.trim());
      const activeRules = lines.filter((l) => l.length > 0 && !l.startsWith("#"));
      expect(activeRules).toContain(".septum/*.db*");
      expect(activeRules).toContain(".septum/");

      // Repeat init must NOT duplicate rules
      ensureGitIgnore(tmpDir);
      const contentRepeat = fs.readFileSync(gitignorePath, "utf-8");
      const linesRepeat = contentRepeat.split(/\r?\n/).map((l) => l.trim());
      const septumDbLines = linesRepeat.filter((l) => l === ".septum/*.db*");
      const septumDirLines = linesRepeat.filter((l) => l === ".septum/");
      expect(septumDbLines).toHaveLength(1);
      expect(septumDirLines).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should verify git check-ignore succeeds when active rules are installed in a git repository", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-f209-git-"));
    try {
      // Initialize real git repo
      execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });

      const gitignorePath = path.join(tmpDir, ".gitignore");
      fs.writeFileSync(gitignorePath, "# Comment mentioning .septum/\n", "utf-8");

      // Before ensureGitIgnore: .septum/septum.db is NOT ignored by git
      let ignoredBefore = false;
      try {
        execFileSync("git", ["check-ignore", "-q", ".septum/septum.db"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        ignoredBefore = true;
      } catch {
        ignoredBefore = false;
      }
      expect(ignoredBefore).toBe(false);

      // Run ensureGitIgnore
      ensureGitIgnore(tmpDir);

      // After ensureGitIgnore: git check-ignore must succeed (exit 0)
      let ignoredAfter = false;
      try {
        execFileSync("git", ["check-ignore", "-q", ".septum/septum.db"], {
          cwd: tmpDir,
          stdio: "ignore",
        });
        ignoredAfter = true;
      } catch {
        ignoredAfter = false;
      }
      expect(ignoredAfter).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("F2-10: Codex TOML Active Table Header Detection", () => {
  it("should create active [mcp_servers.septum] table when config only has commented table header", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-f210-toml-commented-"));
    try {
      const codexDir = path.join(tmpDir, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const tomlPath = path.join(codexDir, "config.toml");
      const commentedToml = `# Codex Configuration\n# [mcp_servers.septum]\n# command = "old_septum"\n# args = []\n\n[general]\nmodel = "o3"\n`;
      fs.writeFileSync(tomlPath, commentedToml, "utf-8");

      appendTomlMcpServer(tomlPath, "septum", "septum", ["serve"], false);

      const tomlAfter = fs.readFileSync(tomlPath, "utf-8");
      // Preserves commented section and general table
      expect(tomlAfter).toContain('# [mcp_servers.septum]');
      expect(tomlAfter).toContain('[general]\nmodel = "o3"');

      // Contains active table header
      const activeHeaderRegex = /^[ \t]*\[mcp_servers\.septum\][ \t]*(?:#.*)?$/m;
      expect(activeHeaderRegex.test(tomlAfter)).toBe(true);
      expect(tomlAfter).toContain('command = "septum"');
      expect(tomlAfter).toContain('args = ["serve"]');

      // Repeat without force must NOT duplicate table
      appendTomlMcpServer(tomlPath, "septum", "septum", ["serve"], false);
      const tomlRepeat = fs.readFileSync(tomlPath, "utf-8");
      const matches = tomlRepeat.match(/^[ \t]*\[mcp_servers\.septum\][ \t]*(?:#.*)?$/gm);
      expect(matches).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should integrate correctly with configureHarness for codex with commented table", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-f210-harness-"));
    try {
      const codexDir = path.join(tmpDir, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const tomlPath = path.join(codexDir, "config.toml");
      const initialContent = `# Example: [mcp_servers.septum]\n[general]\nenvironment = "dev"\n`;
      fs.writeFileSync(tomlPath, initialContent, "utf-8");

      const configured = configureHarness("codex", tmpDir, false);
      expect(configured).toContain(".codex/config.toml");

      const tomlAfter = fs.readFileSync(tomlPath, "utf-8");
      expect(tomlAfter).toContain('# Example: [mcp_servers.septum]');
      expect(tomlAfter).toContain('[general]\nenvironment = "dev"');
      const matches = tomlAfter.match(/^[ \t]*\[mcp_servers\.septum\][ \t]*(?:#.*)?$/gm);
      expect(matches).toHaveLength(1);
      expect(tomlAfter).toContain('command = "septum"');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

