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

  it("should preserve malformed Goose YAML bytes without overwriting", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-cfg-malformed-yaml-"));
    try {
      const gooseDir = path.join(tmpDir, ".goose");
      fs.mkdirSync(gooseDir, { recursive: true });
      const gooseConfigPath = path.join(gooseDir, "config.yaml");
      const malformedYaml = "extensions: [ USER_INVALID_YAML";
      fs.writeFileSync(gooseConfigPath, malformedYaml, "utf-8");

      configureHarness("goose", tmpDir, false);

      expect(fs.readFileSync(gooseConfigPath, "utf-8")).toBe(malformedYaml);
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
});
