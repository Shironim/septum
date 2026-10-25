import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configureHarness,
  scaffoldAgentCustomizations,
} from "../../src/cli/scaffold/harness-config.ts";

describe("F2-06: Config & Template Preservation on Init", () => {
  it("should preserve malformed JSON config bytes without overwriting and log diagnostic", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-cfg-malformed-json-"));
    try {
      const mcpPath = path.join(tmpDir, ".mcp.json");
      const malformedContent = "{ USER_MALFORMED_JSON";
      fs.writeFileSync(mcpPath, malformedContent, "utf-8");

      const claudeDir = path.join(tmpDir, ".claude");
      fs.mkdirSync(claudeDir, { recursive: true });
      const claudeSettingsPath = path.join(claudeDir, "settings.json");
      const malformedSettings = "{ USER_MALFORMED_SETTINGS";
      fs.writeFileSync(claudeSettingsPath, malformedSettings, "utf-8");

      const res = configureHarness("claude", tmpDir, false);

      expect(fs.readFileSync(mcpPath, "utf-8")).toBe(malformedContent);
      expect(fs.readFileSync(claudeSettingsPath, "utf-8")).toBe(malformedSettings);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should preserve non-object JSON root without crashing or overwriting", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-cfg-wrong-shape-"));
    try {
      const mcpPath = path.join(tmpDir, ".mcp.json");
      const stringJson = '"USER_STRING_CONFIG"';
      fs.writeFileSync(mcpPath, stringJson, "utf-8");

      expect(() => {
        configureHarness("claude", tmpDir, false);
      }).not.toThrow();

      expect(fs.readFileSync(mcpPath, "utf-8")).toBe(stringJson);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should preserve malformed Opencode JSON bytes without overwriting", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-cfg-malformed-opencode-"));
    try {
      const opencodeConfigPath = path.join(tmpDir, "opencode.json");
      const malformedJson = "{ USER_INVALID_OPENCODE";
      fs.writeFileSync(opencodeConfigPath, malformedJson, "utf-8");

      configureHarness("opencode", tmpDir, false);

      expect(fs.readFileSync(opencodeConfigPath, "utf-8")).toBe(malformedJson);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should preserve user customizations in skill, rule, and guard on init without force", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-cfg-custom-agent-"));
    try {
      const geminiDir = path.join(tmpDir, ".gemini");
      const skillDir = path.join(geminiDir, "skills", "septum-map");
      const rulesDir = path.join(geminiDir, "rules");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      const customSkill = "USER_CUSTOM_SKILL";
      const customRule = "USER_CUSTOM_RULE";
      const skillPath = path.join(skillDir, "SKILL.md");
      const rulePath = path.join(rulesDir, "septum-boundary.md");
      fs.writeFileSync(skillPath, customSkill, "utf-8");
      fs.writeFileSync(rulePath, customRule, "utf-8");

      const hooksJsonPath = path.join(geminiDir, "hooks.json");
      const initialHooks = {
        "user-custom-hook": { enabled: true },
        "septum-boundary-guard": { user_override: true },
      };
      fs.writeFileSync(hooksJsonPath, JSON.stringify(initialHooks, null, 2), "utf-8");

      scaffoldAgentCustomizations(tmpDir, false);

      expect(fs.readFileSync(skillPath, "utf-8")).toBe(customSkill);
      expect(fs.readFileSync(rulePath, "utf-8")).toBe(customRule);

      const parsedHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      expect(parsedHooks["user-custom-hook"]).toEqual({ enabled: true });
      expect(parsedHooks["septum-boundary-guard"]).toEqual({ user_override: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should update/regenerate skill and rule on force", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-cfg-force-agent-"));
    try {
      const geminiDir = path.join(tmpDir, ".gemini");
      const skillDir = path.join(geminiDir, "skills", "septum-map");
      const rulesDir = path.join(geminiDir, "rules");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });

      const customSkill = "USER_CUSTOM_SKILL";
      const customRule = "USER_CUSTOM_RULE";
      const skillPath = path.join(skillDir, "SKILL.md");
      const rulePath = path.join(rulesDir, "septum-boundary.md");
      fs.writeFileSync(skillPath, customSkill, "utf-8");
      fs.writeFileSync(rulePath, customRule, "utf-8");

      const hooksJsonPath = path.join(geminiDir, "hooks.json");
      const initialHooks = {
        "user-custom-hook": { enabled: true },
        "septum-boundary-guard": { user_override: true },
      };
      fs.writeFileSync(hooksJsonPath, JSON.stringify(initialHooks, null, 2), "utf-8");

      scaffoldAgentCustomizations(tmpDir, true);

      expect(fs.readFileSync(skillPath, "utf-8")).toContain("name: septum-map");
      expect(fs.readFileSync(rulePath, "utf-8")).toContain("septum_domain");

      const parsedHooks = JSON.parse(fs.readFileSync(hooksJsonPath, "utf-8"));
      expect(parsedHooks["user-custom-hook"]).toEqual({ enabled: true });
      expect(parsedHooks["septum-boundary-guard"].PreToolUse).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should preserve existing user custom septum server and unrelated servers in .mcp.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-cfg-custom-mcp-"));
    try {
      const mcpPath = path.join(tmpDir, ".mcp.json");
      const initialMcp = {
        user_setting: true,
        mcpServers: {
          other: { command: "keep" },
          septum: { command: "user-septum", args: ["custom"] },
        },
      };
      fs.writeFileSync(mcpPath, JSON.stringify(initialMcp, null, 2), "utf-8");

      configureHarness("claude", tmpDir, false);

      const parsedMcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
      expect(parsedMcp.user_setting).toBe(true);
      expect(parsedMcp.mcpServers.other).toEqual({ command: "keep" });
      expect(parsedMcp.mcpServers.septum).toEqual({ command: "user-septum", args: ["custom"] });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should update septum server entry in .mcp.json when force is true", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-cfg-force-mcp-"));
    try {
      const mcpPath = path.join(tmpDir, ".mcp.json");
      const initialMcp = {
        user_setting: true,
        mcpServers: {
          other: { command: "keep" },
          septum: { command: "user-septum", args: ["custom"] },
        },
      };
      fs.writeFileSync(mcpPath, JSON.stringify(initialMcp, null, 2), "utf-8");

      configureHarness("claude", tmpDir, true);

      const parsedMcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
      expect(parsedMcp.user_setting).toBe(true);
      expect(parsedMcp.mcpServers.other).toEqual({ command: "keep" });
      expect(parsedMcp.mcpServers.septum).toEqual({ command: "septum", args: ["serve"] });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("Focused 5 AI Agent Harnesses Architecture", () => {
    it("should strictly support only the 5 target harnesses (antigravity, claude, codex, opencode, agents)", async () => {
      const { SUPPORTED_HARNESSES } = await import("../../src/cli/scaffold/harness-config.ts");
      const ids = SUPPORTED_HARNESSES.map((h) => h.id);

      expect(ids).toEqual(["antigravity", "claude", "codex", "opencode", "agents"]);
      expect(ids).not.toContain("cursor");
      expect(ids).not.toContain("goose");
      expect(ids).not.toContain("pi");
    });

    it("should scaffold skills, rules, hooks, and mcp for Antigravity (.gemini)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-test-antigravity-"));
      try {
        const res = configureHarness("antigravity", tmpDir, false);
        expect(res).toContain(".gemini/");

        expect(fs.existsSync(path.join(tmpDir, ".gemini", "skills", "septum-map", "SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".gemini", "rules", "septum-boundary.md"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".gemini", "hooks", "septum-pre-write.sh"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".gemini", "hooks", "septum-post-write.sh"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".gemini", "hooks.json"))).toBe(true);

        const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, ".gemini", "mcp_config.json"), "utf-8"));
        expect(mcp.mcpServers.septum).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should scaffold skills, hooks, CLAUDE.md and mcp in .claude and root for Claude Code (.claude)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-test-claude-"));
      try {
        const res = configureHarness("claude", tmpDir, false);
        expect(res).toContain(".mcp.json");

        expect(fs.existsSync(path.join(tmpDir, ".claude", "skills", "septum-map", "SKILL.md"))).toBe(true);
        // Rules must NOT be generated for Claude Code
        expect(fs.existsSync(path.join(tmpDir, ".claude", "rules", "septum-boundary.md"))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".claude", "hooks", "septum-pre-write.sh"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".claude", "settings.json"))).toBe(true);

        // MCP server must be configured in both .claude/mcp.json and root .mcp.json
        expect(fs.existsSync(path.join(tmpDir, ".claude", "mcp.json"))).toBe(true);
        const claudeMcp = JSON.parse(fs.readFileSync(path.join(tmpDir, ".claude", "mcp.json"), "utf-8"));
        expect(claudeMcp.mcpServers.septum).toBeDefined();

        expect(fs.existsSync(path.join(tmpDir, ".mcp.json"))).toBe(true);
        const rootMcp = JSON.parse(fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"));
        expect(rootMcp.mcpServers.septum).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should scaffold skills, hooks, and mcp for Codex (.codex) without rules", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-test-codex-"));
      try {
        const res = configureHarness("codex", tmpDir, false);
        expect(res).toContain(".codex/");

        expect(fs.existsSync(path.join(tmpDir, ".codex", "skills", "septum-map", "SKILL.md"))).toBe(true);
        // Rules must NOT be generated for Codex
        expect(fs.existsSync(path.join(tmpDir, ".codex", "rules", "septum-boundary.md"))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks", "septum-pre-write.sh"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks.json"))).toBe(true);

        const tomlContent = fs.readFileSync(path.join(tmpDir, ".codex", "config.toml"), "utf-8");
        expect(tomlContent).toContain("[mcp_servers.septum]");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should scaffold skills, hooks, and mcp for Opencode (opencode/) without rules", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-test-opencode-"));
      try {
        const res = configureHarness("opencode", tmpDir, false);
        expect(res).toContain("opencode");

        expect(fs.existsSync(path.join(tmpDir, "opencode", "skills", "septum-map", "SKILL.md"))).toBe(true);
        // Rules must NOT be generated for Opencode
        expect(fs.existsSync(path.join(tmpDir, "opencode", "rules", "septum-boundary.md"))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, "opencode", "hooks", "septum-pre-write.sh"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, "opencode", "hooks.json"))).toBe(true);

        const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, "opencode.json"), "utf-8"));
        expect(mcp.mcp.septum).toBeDefined();
        expect(mcp.mcp.septum.type).toBe("local");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should scaffold skills, hooks, AGENTS.md, and mcp for .agents standard without rules", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-test-agents-"));
      try {
        const res = configureHarness("agents", tmpDir, false);
        expect(res).toContain(".agents");

        expect(fs.existsSync(path.join(tmpDir, ".agents", "skills", "septum-map", "SKILL.md"))).toBe(true);
        // Rules must NOT be generated for .agents standard
        expect(fs.existsSync(path.join(tmpDir, ".agents", "rules", "septum-boundary.md"))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".agents", "hooks", "septum-pre-write.sh"))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, ".agents", "hooks.json"))).toBe(true);

        const mcp = JSON.parse(fs.readFileSync(path.join(tmpDir, ".agents", "mcp.json"), "utf-8"));
        expect(mcp.mcpServers.septum).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
