import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SEPTUM_HOOKS_CONFIG, SEPTUM_PRE_WRITE_SCRIPT } from "../../src/cli/templates/hooks.ts";
import { SEPTUM_RULES_TEMPLATE } from "../../src/cli/templates/rules.ts";
import { SEPTUM_MAP_SKILL_TEMPLATE } from "../../src/cli/templates/skill.ts";

describe("Agentic Scaffolding Templates", () => {
  it("should contain valid frontmatter and content for septum-map skill", () => {
    expect(SEPTUM_MAP_SKILL_TEMPLATE).toContain("name: septum-map");
    expect(SEPTUM_MAP_SKILL_TEMPLATE).toContain("Framework-Agnostic");
    expect(SEPTUM_MAP_SKILL_TEMPLATE).toContain("Semantic Blueprint Drafting");
  });

  it("should configure PreToolUse interceptors on write_to_file and replace_file_content", () => {
    const guardConfig = SEPTUM_HOOKS_CONFIG["septum-boundary-guard"] as any;
    expect(guardConfig).toBeDefined();
    expect(guardConfig.PreToolUse[0].matcher).toContain("write_to_file");
    expect(guardConfig.PreToolUse[0].matcher).toContain("replace_file_content");
  });

  it("should provide prescriptive boundary rules for AI agents", () => {
    expect(SEPTUM_RULES_TEMPLATE).toContain("septum_get_domain_catalog");
    expect(SEPTUM_RULES_TEMPLATE).toContain("septum_check_boundary");
    expect(SEPTUM_RULES_TEMPLATE).toContain("allowed_touchpoints");
  });

  it("should scaffold complete .agents/ directory structure in a target project", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-scaffold-test-"));

    try {
      const agentsDir = path.join(tmpDir, ".agents");

      // 1. Skill
      const skillDir = path.join(agentsDir, "skills", "septum-map");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), SEPTUM_MAP_SKILL_TEMPLATE, "utf-8");

      // 2. Rule
      const rulesDir = path.join(agentsDir, "rules");
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, "septum-boundary.md"), SEPTUM_RULES_TEMPLATE, "utf-8");

      // 3. Hook script
      const hooksDir = path.join(agentsDir, "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(path.join(hooksDir, "septum-pre-write.sh"), SEPTUM_PRE_WRITE_SCRIPT, "utf-8");

      // 4. Hooks config with merge
      const initialHooks = { "user-custom-hook": { enabled: true } };
      const merged = { ...initialHooks, ...SEPTUM_HOOKS_CONFIG };
      fs.writeFileSync(path.join(agentsDir, "hooks.json"), JSON.stringify(merged, null, 2), "utf-8");

      // Verify files
      expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(rulesDir, "septum-boundary.md"))).toBe(true);
      expect(fs.existsSync(path.join(hooksDir, "septum-pre-write.sh"))).toBe(true);

      const parsedHooks = JSON.parse(fs.readFileSync(path.join(agentsDir, "hooks.json"), "utf-8"));
      expect(parsedHooks["user-custom-hook"]).toBeDefined();
      expect(parsedHooks["septum-boundary-guard"]).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
