import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installGitHook } from "../../src/cli/commands/init.ts";
import {
  configureHarness,
  ensureSharedHookScripts,
  scaffoldAgentCustomizations,
} from "../../src/cli/scaffold/harness-config.ts";
import { SEPTUM_MAP_SKILL_TEMPLATE } from "../../src/cli/templates/skill.ts";
import { SEPTUM_RULES_TEMPLATE } from "../../src/cli/templates/rules.ts";
import {
  SEPTUM_POST_WRITE_SCRIPT,
  SEPTUM_PRE_WRITE_SCRIPT,
} from "../../src/cli/templates/hooks.ts";

describe("F2-07: Narrow --force Semantics on Init", () => {
  let baseDir: string;

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-force-all-"));
  });

  afterAll(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  it("should force-regenerate Septum git hook but preserve user non-Septum hook", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-force-hook-"));
    try {
      const gitDir = path.join(tmpDir, ".git");
      const hooksDir = path.join(gitDir, "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });

      // 1. Existing Septum hook with minor modification
      const preCommitHook = path.join(hooksDir, "pre-commit");
      fs.writeFileSync(
        preCommitHook,
        `#!/usr/bin/env sh\n# Septum deterministic boundary pre-commit hook\necho "CUSTOM_SEPTUM_TWEAK"\nseptum check --staged\n`,
        { mode: 0o755, encoding: "utf-8" }
      );

      // Without force: stays updated or already_installed
      const resWithoutForce = installGitHook(tmpDir, false);
      expect(resWithoutForce.status).toBe("updated");

      // Now set content to canonical script
      const canonicalScript = fs.readFileSync(preCommitHook, "utf-8");
      // Repeat without force: reports already_installed
      const repeatRes = installGitHook(tmpDir, false);
      expect(repeatRes.status).toBe("already_installed");

      // With force: force-regenerates with updated status and sets 0o755
      const resWithForce = installGitHook(tmpDir, true);
      expect(resWithForce.status).toBe("updated");
      expect(fs.readFileSync(preCommitHook, "utf-8")).toBe(canonicalScript);
      const stat = fs.statSync(preCommitHook);
      expect(stat.mode & 0o777).toBe(0o755);

      // 2. Non-Septum user hook must NOT be overwritten even with --force
      const userHookContent = "#!/bin/bash\necho USER_INTEGRITY_CHECK\nexit 42\n";
      fs.writeFileSync(preCommitHook, userHookContent, { mode: 0o700, encoding: "utf-8" });
      fs.chmodSync(preCommitHook, 0o700);

      const userHookForceRes = installGitHook(tmpDir, true);
      expect(userHookForceRes.status).toBe("preserved_user_hook");
      expect(fs.readFileSync(preCommitHook, "utf-8")).toBe(userHookContent);
      expect(fs.statSync(preCommitHook).mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should force-regenerate Septum block in .husky/pre-commit while preserving user commands", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-force-husky-"));
    try {
      const gitDir = path.join(tmpDir, ".git");
      const huskyDir = path.join(tmpDir, ".husky");
      fs.mkdirSync(gitDir, { recursive: true });
      fs.mkdirSync(huskyDir, { recursive: true });

      const huskyPreCommit = path.join(huskyDir, "pre-commit");
      const initialHusky = `#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n\nnpm test\n\n# Septum deterministic boundary pre-commit hook\nold_septum_command\nfi\n\necho "USER_POST_CHECK"\n`;
      fs.writeFileSync(huskyPreCommit, initialHusky, "utf-8");

      // With force, Septum block is replaced with canonical command, and user commands remain
      const res = installGitHook(tmpDir, true);
      expect(res.status).toBe("updated");

      const after = fs.readFileSync(huskyPreCommit, "utf-8");
      expect(after).toContain("npm test");
      expect(after).toContain('echo "USER_POST_CHECK"');
      expect(after).toContain("bun run ./bin/septum.ts check --staged");
      expect(after).not.toContain("old_septum_command");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should force-regenerate shared hook scripts and agent templates", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-force-agent-"));
    try {
      const geminiDir = path.join(tmpDir, ".gemini");
      const skillDir = path.join(geminiDir, "skills", "septum-map");
      const rulesDir = path.join(geminiDir, "rules");
      const hooksDir = path.join(geminiDir, "hooks");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.mkdirSync(hooksDir, { recursive: true });

      const customSkill = "USER_CUSTOM_MAP_SKILL";
      const customRule = "USER_CUSTOM_BOUNDARY_RULE";
      const customPreWrite = "#!/bin/sh\necho CUSTOM_PRE_WRITE\n";
      const customPostWrite = "#!/bin/sh\necho CUSTOM_POST_WRITE\n";

      const skillFile = path.join(skillDir, "SKILL.md");
      const ruleFile = path.join(rulesDir, "septum-boundary.md");
      const preWriteFile = path.join(hooksDir, "septum-pre-write.sh");
      const postWriteFile = path.join(hooksDir, "septum-post-write.sh");

      fs.writeFileSync(skillFile, customSkill, "utf-8");
      fs.writeFileSync(ruleFile, customRule, "utf-8");
      fs.writeFileSync(preWriteFile, customPreWrite, "utf-8");
      fs.writeFileSync(postWriteFile, customPostWrite, "utf-8");

      // Without force: user customizations are preserved
      scaffoldAgentCustomizations(tmpDir, false);
      expect(fs.readFileSync(skillFile, "utf-8")).toBe(customSkill);
      expect(fs.readFileSync(ruleFile, "utf-8")).toBe(customRule);
      expect(fs.readFileSync(preWriteFile, "utf-8")).toBe(customPreWrite);
      expect(fs.readFileSync(postWriteFile, "utf-8")).toBe(customPostWrite);

      // With force: force-regenerates templates and hook scripts
      scaffoldAgentCustomizations(tmpDir, true);
      expect(fs.readFileSync(skillFile, "utf-8")).toBe(SEPTUM_MAP_SKILL_TEMPLATE);
      expect(fs.readFileSync(ruleFile, "utf-8")).toBe(SEPTUM_RULES_TEMPLATE);
      expect(fs.readFileSync(preWriteFile, "utf-8")).toBe(SEPTUM_PRE_WRITE_SCRIPT);
      expect(fs.readFileSync(postWriteFile, "utf-8")).toBe(SEPTUM_POST_WRITE_SCRIPT);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should force-regenerate Septum PreToolUse hooks in Claude Code while preserving user hooks", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-force-claude-"));
    try {
      const claudeDir = path.join(tmpDir, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, "settings.json");

      const userHook = {
        matcher: "Bash",
        hooks: [{ type: "command", command: "echo USER_BASH_HOOK" }],
      };
      const oldSeptumHook = {
        matcher: "Write|Edit",
        hooks: [{ type: "command", command: "sh -c 'OLD_SEPTUM_COMMAND septum-pre-write.sh'" }],
      };
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          user_preference: "dark_mode",
          hooks: {
            PreToolUse: [userHook, oldSeptumHook],
          },
        }, null, 2),
        "utf-8"
      );

      // Without force: leaves existing hooks untouched
      configureHarness("claude", tmpDir, false);
      const afterWithoutForce = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      expect(afterWithoutForce.hooks.PreToolUse).toHaveLength(2);
      expect(afterWithoutForce.hooks.PreToolUse[1].hooks[0].command).toContain("OLD_SEPTUM_COMMAND");

      // With force: updates Septum hook to canonical, keeps user hook and preferences intact
      configureHarness("claude", tmpDir, true);
      const afterWithForce = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      expect(afterWithForce.user_preference).toBe("dark_mode");
      expect(afterWithForce.hooks.PreToolUse).toHaveLength(2);
      expect(afterWithForce.hooks.PreToolUse[0]).toEqual(userHook);
      expect(afterWithForce.hooks.PreToolUse[1].matcher).toBe("Write|Edit|NotebookEdit");
      expect(afterWithForce.hooks.PreToolUse[1].hooks[0].command).toContain("--exit-code-2");
      expect(afterWithForce.hooks.PreToolUse[1].hooks[0].command).not.toContain("OLD_SEPTUM_COMMAND");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should force-regenerate Codex lifecycle hooks while preserving user hooks", () => {
    const tmpDir = fs.mkdtempSync(path.join(baseDir, "force-codex-"));
    try {
      const codexDir = path.join(tmpDir, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const codexHooksPath = path.join(codexDir, "hooks.json");
      const codexUserHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo USER_CODEX" }] };
      const codexOldSeptum = { matcher: "Write", hooks: [{ type: "command", command: "OLD_CODEX_SEPTUM septum-pre-write.sh" }] };
      fs.writeFileSync(
        codexHooksPath,
        JSON.stringify({
          hooks: {
            PreToolUse: [codexUserHook, codexOldSeptum],
          },
        }, null, 2),
        "utf-8"
      );

      configureHarness("codex", tmpDir, true);
      const codexAfter = JSON.parse(fs.readFileSync(codexHooksPath, "utf-8"));
      expect(codexAfter.hooks.PreToolUse).toHaveLength(2);
      expect(codexAfter.hooks.PreToolUse[0]).toEqual(codexUserHook);
      expect(codexAfter.hooks.PreToolUse[1].hooks[0].command).toContain("--exit-code-2");
      expect(codexAfter.hooks.PreToolUse[1].hooks[0].command).not.toContain("OLD_CODEX_SEPTUM");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should update [mcp_servers.septum] in .codex/config.toml on --force while preserving other tables", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-force-codex-toml-"));
    try {
      const codexDir = path.join(tmpDir, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const tomlPath = path.join(codexDir, "config.toml");
      const initialToml = `[general]\nmodel = "o3"\n\n[mcp_servers.septum]\ncommand = "old_septum"\nargs = ["legacy"]\n\n[mcp_servers.other]\ncommand = "other_tool"\nargs = []\n`;
      fs.writeFileSync(tomlPath, initialToml, "utf-8");

      // Without force: leaves old septum config untouched
      configureHarness("codex", tmpDir, false);
      expect(fs.readFileSync(tomlPath, "utf-8")).toBe(initialToml);

      // With force: updates [mcp_servers.septum] to canonical while preserving [general] and [mcp_servers.other]
      configureHarness("codex", tmpDir, true);
      const updatedToml = fs.readFileSync(tomlPath, "utf-8");
      expect(updatedToml).toContain('[general]\nmodel = "o3"');
      expect(updatedToml).toContain('[mcp_servers.other]\ncommand = "other_tool"');
      expect(updatedToml).toContain('command = "septum"\nargs = ["serve"]');
      expect(updatedToml).not.toContain("old_septum");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

