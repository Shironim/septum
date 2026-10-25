import * as fs from "node:fs";
import * as path from "node:path";
import {
  SEPTUM_HOOKS_CONFIG,
  SEPTUM_POST_WRITE_SCRIPT,
  SEPTUM_PRE_WRITE_SCRIPT,
} from "../templates/hooks.ts";
import { SEPTUM_RULES_TEMPLATE } from "../templates/rules.ts";
import { SEPTUM_MAP_SKILL_TEMPLATE } from "../templates/skill.ts";

export interface HarnessOption {
  id: string;
  name: string;
  targetFile: string;
  description: string;
  selectedByDefault?: boolean;
}

export const SUPPORTED_HARNESSES: HarnessOption[] = [
  {
    id: "antigravity",
    name: "Antigravity",
    targetFile: ".gemini/ (skills, rules, hooks, mcp_config.json)",
    description: "Skills, rules, hooks, and MCP config for Antigravity AI agents",
    selectedByDefault: true,
  },
  {
    id: "claude",
    name: "Claude Code",
    targetFile: ".claude/ (skills, hooks, mcp.json, settings.json) & .mcp.json & CLAUDE.md",
    description: "Skills, hooks, and MCP config for Claude Code",
    selectedByDefault: true,
  },
  {
    id: "codex",
    name: "Codex",
    targetFile: ".codex/ (skills, hooks.json, config.toml)",
    description: "Skills, hooks, and MCP config for OpenAI Codex CLI",
    selectedByDefault: false,
  },
  {
    id: "opencode",
    name: "Opencode",
    targetFile: "opencode/ (skills, hooks) & opencode.json",
    description: "Skills, hooks, and MCP config for Opencode AI harness",
    selectedByDefault: false,
  },
  {
    id: "agents",
    name: ".agents",
    targetFile: ".agents/ (skills, hooks, mcp.json) & AGENTS.md",
    description: "Cross-agent skills, hooks, and MCP config following the .agents standard",
    selectedByDefault: false,
  },
];

export type ConfigReadResult<T = Record<string, any>> =
  | { status: "missing" }
  | { status: "valid"; data: T }
  | { status: "malformed"; error: string; raw: string };

export function readJsonConfigFile<T = Record<string, any>>(filePath: string): ConfigReadResult<T> {
  if (!fs.existsSync(filePath)) return { status: "missing" };
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        status: "malformed",
        error: `Expected JSON object root, found ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`,
        raw,
      };
    }
    return { status: "valid", data: parsed as T };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "malformed",
      error: `Malformed JSON syntax: ${message}`,
      raw,
    };
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function configureHarness(
  harnessId: string,
  cwd: string = process.cwd(),
  force: boolean = false,
  outErrors?: string[]
): string | null {
  switch (harnessId) {
    case "antigravity": {
      // 1. Skill, Rules, and Hook scripts in .gemini/
      scaffoldHarnessCustomizations(".gemini", cwd, force, outErrors, { includeRules: true });

      // 2. MCP config in .gemini/mcp_config.json
      const geminiDir = path.join(cwd, ".gemini");
      const mcpConfigPath = path.join(geminiDir, "mcp_config.json");
      const result = readJsonConfigFile(mcpConfigPath);
      if (result.status === "malformed") {
        console.error(`  ✕ Error: Malformed JSON in '.gemini/mcp_config.json': ${result.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed JSON in '.gemini/mcp_config.json': ${result.error}`);
      } else {
        const existing = result.status === "valid" ? result.data : {};
        const servers = (typeof existing.mcpServers === "object" && existing.mcpServers !== null && !Array.isArray(existing.mcpServers))
          ? existing.mcpServers
          : {};
        if (!servers.septum || force) {
          servers.septum = {
            command: "septum",
            args: ["serve"],
          };
          existing.mcpServers = servers;
          writeJsonFile(mcpConfigPath, existing);
        }
      }
      return ".gemini/ (skills, rules, hooks, mcp_config.json)";
    }

    case "claude": {
      const configured: string[] = [];

      // 1. Skills and Hook scripts in .claude/ + CLAUDE.md root guidance (rules omitted as Claude Code does not support rules/)
      scaffoldHarnessCustomizations(".claude", cwd, force, outErrors, { rootDoc: "CLAUDE.md", includeRules: false });

      // 2. MCP config in .claude/mcp.json and .mcp.json (project root)
      const claudeDir = path.join(cwd, ".claude");
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      const claudeMcpPath = path.join(claudeDir, "mcp.json");
      const rootMcpPath = path.join(cwd, ".mcp.json");

      for (const configPath of [claudeMcpPath, rootMcpPath]) {
        const mcpResult = readJsonConfigFile(configPath);
        if (mcpResult.status === "malformed") {
          const relPath = path.relative(cwd, configPath);
          console.error(`  ✕ Error: Malformed JSON in '${relPath}': ${mcpResult.error}. Preserving existing file without modification.`);
          if (outErrors) outErrors.push(`Malformed JSON in '${relPath}': ${mcpResult.error}`);
        } else {
          const existing = mcpResult.status === "valid" ? mcpResult.data : {};
          const servers = (typeof existing.mcpServers === "object" && existing.mcpServers !== null && !Array.isArray(existing.mcpServers))
            ? existing.mcpServers
            : {};
          if (!servers.septum || force) {
            servers.septum = {
              command: "septum",
              args: ["serve"],
            };
            existing.mcpServers = servers;
            writeJsonFile(configPath, existing);
          }
          const relPath = path.relative(cwd, configPath);
          configured.push(relPath);
        }
      }
      console.log("  ✓ Configured Claude Code MCP server in '.claude/mcp.json' & '.mcp.json'.");

      // 3. Lifecycle hooks in .claude/settings.json
      const claudeSettingsPath = path.join(cwd, ".claude", "settings.json");
      const claudeResult = readJsonConfigFile(claudeSettingsPath);
      if (claudeResult.status === "malformed") {
        console.error(`  ✕ Error: Malformed JSON in '.claude/settings.json': ${claudeResult.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed JSON in '.claude/settings.json': ${claudeResult.error}`);
      } else {
        const claudeSettings = claudeResult.status === "valid" ? claudeResult.data : {};
        const claudeHooks = (typeof claudeSettings.hooks === "object" && claudeSettings.hooks !== null && !Array.isArray(claudeSettings.hooks))
          ? claudeSettings.hooks
          : {};
        const preToolHooks = Array.isArray(claudeHooks.PreToolUse) ? claudeHooks.PreToolUse : [];

        const hasSeptumHook = preToolHooks.some((h: any) => {
          if (Array.isArray(h?.hooks)) {
            return h.hooks.some((hk: any) => typeof hk?.command === "string" && hk.command.includes("septum-pre-write"));
          }
          return typeof h?.command === "string" && h.command.includes("septum-pre-write");
        });
        const canonicalHook = {
          matcher: "Write|Edit|NotebookEdit",
          hooks: [
            {
              type: "command",
              command:
                "sh -c 'ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\"; for d in .claude .gemini .codex opencode .agents; do if [ -f \"$ROOT/$d/hooks/septum-pre-write.sh\" ]; then exec \"$ROOT/$d/hooks/septum-pre-write.sh\" --exit-code-2 \"$@\"; fi; done; exit 0'",
            },
          ],
        };
        if (!hasSeptumHook) {
          preToolHooks.push(canonicalHook);
          claudeHooks.PreToolUse = preToolHooks;
          claudeSettings.hooks = claudeHooks;
          writeJsonFile(claudeSettingsPath, claudeSettings);
          console.log("  ✓ Configured Claude Code lifecycle boundary guard: '.claude/settings.json'.");
        } else if (force) {
          const cleanedHooks: any[] = [];
          for (const h of preToolHooks) {
            if (Array.isArray(h?.hooks)) {
              const userHooks = h.hooks.filter((hk: any) =>
                !(typeof hk?.command === "string" && hk.command.includes("septum-pre-write"))
              );
              if (userHooks.length > 0) {
                cleanedHooks.push({ ...h, hooks: userHooks });
              }
            } else if (typeof h?.command === "string" && h.command.includes("septum-pre-write")) {
              // Dedicated single command hook, omit
            } else if (!JSON.stringify(h).includes("septum-pre-write")) {
              cleanedHooks.push(h);
            }
          }
          cleanedHooks.push(canonicalHook);
          claudeHooks.PreToolUse = cleanedHooks;
          claudeSettings.hooks = claudeHooks;
          writeJsonFile(claudeSettingsPath, claudeSettings);
          console.log("  ✓ Force-regenerated Claude Code lifecycle boundary guard: '.claude/settings.json' (--force).");
        }
        configured.push(".claude/settings.json");
      }

      return configured.length > 0 ? configured.join(" & ") : null;
    }

    case "codex": {
      const configured: string[] = [];

      // 1. Skills and Hook scripts in .codex/ (rules omitted as Codex CLI does not support rules/)
      scaffoldHarnessCustomizations(".codex", cwd, force, outErrors, { includeRules: false });

      // 2. MCP config in .codex/config.toml
      const codexDir = path.join(cwd, ".codex");
      if (!fs.existsSync(codexDir)) {
        fs.mkdirSync(codexDir, { recursive: true });
      }
      const configTomlPath = path.join(codexDir, "config.toml");
      appendTomlMcpServer(configTomlPath, "septum", "septum", ["serve"], force);
      configured.push(".codex/config.toml");

      // 3. Lifecycle hooks in .codex/hooks.json
      const codexHooksPath = path.join(codexDir, "hooks.json");
      const hooksResult = readJsonConfigFile(codexHooksPath);
      if (hooksResult.status === "malformed") {
        console.error(`  ✕ Error: Malformed JSON in '.codex/hooks.json': ${hooksResult.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed JSON in '.codex/hooks.json': ${hooksResult.error}`);
      } else {
        const codexHooksConfig = hooksResult.status === "valid" ? hooksResult.data : { hooks: {} };
        codexHooksConfig.hooks = (typeof codexHooksConfig.hooks === "object" && codexHooksConfig.hooks !== null && !Array.isArray(codexHooksConfig.hooks))
          ? codexHooksConfig.hooks
          : {};
        const preToolUse = Array.isArray(codexHooksConfig.hooks.PreToolUse) ? codexHooksConfig.hooks.PreToolUse : [];

        const hasSeptumHook = preToolUse.some((h: any) => {
          if (Array.isArray(h?.hooks)) {
            return h.hooks.some((hk: any) => typeof hk?.command === "string" && hk.command.includes("septum-pre-write"));
          }
          return typeof h?.command === "string" && h.command.includes("septum-pre-write");
        });
        const canonicalHook = {
          matcher: "Write|Edit|Bash",
          hooks: [
            {
              type: "command",
              command:
                "sh -c 'ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\"; for d in .codex .gemini .claude opencode .agents; do if [ -f \"$ROOT/$d/hooks/septum-pre-write.sh\" ]; then exec \"$ROOT/$d/hooks/septum-pre-write.sh\" --exit-code-2 \"$@\"; fi; done; exit 0'",
            },
          ],
        };
        if (!hasSeptumHook) {
          preToolUse.push(canonicalHook);
          codexHooksConfig.hooks.PreToolUse = preToolUse;
          writeJsonFile(codexHooksPath, codexHooksConfig);
          console.log("  ✓ Configured Codex CLI lifecycle boundary guard: '.codex/hooks.json'.");
        } else if (force) {
          const cleanedHooks: any[] = [];
          for (const h of preToolUse) {
            if (Array.isArray(h?.hooks)) {
              const remaining = h.hooks.filter((hk: any) =>
                !(typeof hk?.command === "string" && hk.command.includes("septum-pre-write"))
              );
              if (remaining.length > 0) cleanedHooks.push({ ...h, hooks: remaining });
            } else if (typeof h?.command === "string" && h.command.includes("septum-pre-write")) {
              // Dedicated single command hook, omit
            } else if (!JSON.stringify(h).includes("septum-pre-write")) {
              cleanedHooks.push(h);
            }
          }
          cleanedHooks.push(canonicalHook);
          codexHooksConfig.hooks.PreToolUse = cleanedHooks;
          writeJsonFile(codexHooksPath, codexHooksConfig);
          console.log("  ✓ Force-regenerated Codex CLI lifecycle boundary guard: '.codex/hooks.json' (--force).");
        }
        configured.push(".codex/hooks.json");
      }

      return configured.length > 0 ? configured.join(" & ") : null;
    }

    case "opencode": {
      const configured: string[] = [];

      // 1. Skills and Hook scripts in opencode/ (rules omitted as Opencode does not support rules/)
      scaffoldHarnessCustomizations("opencode", cwd, force, outErrors, { includeRules: false });
      configured.push("opencode/ (skills, hooks)");

      // 2. MCP config in opencode.json (project root)
      const configPath = path.join(cwd, "opencode.json");
      const result = readJsonConfigFile(configPath);
      if (result.status === "malformed") {
        console.error(`  ✕ Error: Malformed JSON in 'opencode.json': ${result.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed JSON in 'opencode.json': ${result.error}`);
      } else {
        const existing = result.status === "valid" ? result.data : {};
        const mcp = (typeof existing.mcp === "object" && existing.mcp !== null && !Array.isArray(existing.mcp))
          ? existing.mcp
          : {};
        if (!mcp.septum || force) {
          mcp.septum = {
            type: "local",
            command: ["septum", "serve"],
          };
          existing.mcp = mcp;
          writeJsonFile(configPath, existing);
          console.log("  ✓ Configured Opencode MCP server in 'opencode.json'.");
        }
        configured.push("opencode.json");
      }

      return configured.join(" & ");
    }

    case "agents": {
      const configured: string[] = [];

      // 1. Skills and Hook scripts in .agents/ + AGENTS.md root guidance (rules omitted as standard uses AGENTS.md)
      scaffoldHarnessCustomizations(".agents", cwd, force, outErrors, { rootDoc: "AGENTS.md", includeRules: false });
      configured.push(".agents/ (skills, hooks)");

      // 2. MCP config in .agents/mcp.json
      const agentsDir = path.join(cwd, ".agents");
      const mcpPath = path.join(agentsDir, "mcp.json");
      const mcpResult = readJsonConfigFile(mcpPath);
      if (mcpResult.status === "malformed") {
        console.error(`  ✕ Error: Malformed JSON in '.agents/mcp.json': ${mcpResult.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed JSON in '.agents/mcp.json': ${mcpResult.error}`);
      } else {
        const existing = mcpResult.status === "valid" ? mcpResult.data : {};
        const servers = (typeof existing.mcpServers === "object" && existing.mcpServers !== null && !Array.isArray(existing.mcpServers))
          ? existing.mcpServers
          : {};
        if (!servers.septum || force) {
          servers.septum = {
            command: "septum",
            args: ["serve"],
          };
          existing.mcpServers = servers;
          writeJsonFile(mcpPath, existing);
          console.log("  ✓ Configured .agents MCP server in '.agents/mcp.json'.");
        }
        configured.push(".agents/mcp.json");
      }

      return configured.join(" & ");
    }

    default:
      return null;
  }
}

export function scaffoldHarnessCustomizations(
  harnessDirName: string,
  cwd: string = process.cwd(),
  force: boolean = false,
  outErrors?: string[],
  options?: { rootDoc?: string; includeRules?: boolean }
): void {
  const targetDir = path.join(cwd, harnessDirName);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 1. Skill: <harnessDir>/skills/septum-map/SKILL.md
  const skillDir = path.join(targetDir, "skills", "septum-map");
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }
  const skillPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    fs.writeFileSync(skillPath, SEPTUM_MAP_SKILL_TEMPLATE, "utf-8");
    console.log(`  ✓ Deployed AI Agent skill: '${harnessDirName}/skills/septum-map/SKILL.md'.`);
  } else {
    const existing = fs.readFileSync(skillPath, "utf-8");
    if (existing === SEPTUM_MAP_SKILL_TEMPLATE) {
      // Unchanged
    } else if (force) {
      fs.writeFileSync(skillPath, SEPTUM_MAP_SKILL_TEMPLATE, "utf-8");
      console.log(`  ✓ Updated AI Agent skill: '${harnessDirName}/skills/septum-map/SKILL.md' (--force).`);
    } else {
      console.log(`  ✓ Preserved existing customized AI Agent skill: '${harnessDirName}/skills/septum-map/SKILL.md'.`);
    }
  }

  // 2. Rule: <harnessDir>/rules/septum-boundary.md (Only supported natively by Gemini/Antigravity)
  if (options?.includeRules) {
    const rulesDir = path.join(targetDir, "rules");
    if (!fs.existsSync(rulesDir)) {
      fs.mkdirSync(rulesDir, { recursive: true });
    }
    const rulePath = path.join(rulesDir, "septum-boundary.md");
    if (!fs.existsSync(rulePath)) {
      fs.writeFileSync(rulePath, SEPTUM_RULES_TEMPLATE, "utf-8");
      console.log(`  ✓ Deployed AI Agent boundary rules: '${harnessDirName}/rules/septum-boundary.md'.`);
    } else {
      const existing = fs.readFileSync(rulePath, "utf-8");
      if (existing === SEPTUM_RULES_TEMPLATE) {
        // Unchanged
      } else if (force) {
        fs.writeFileSync(rulePath, SEPTUM_RULES_TEMPLATE, "utf-8");
        console.log(`  ✓ Updated AI Agent boundary rules: '${harnessDirName}/rules/septum-boundary.md' (--force).`);
      } else {
        console.log(`  ✓ Preserved existing customized AI Agent boundary rules: '${harnessDirName}/rules/septum-boundary.md'.`);
      }
    }
  }

  // Optional root document (CLAUDE.md or AGENTS.md)
  if (options?.rootDoc) {
    const rootDocPath = path.join(cwd, options.rootDoc);
    if (!fs.existsSync(rootDocPath)) {
      fs.writeFileSync(rootDocPath, `# ${options.rootDoc} Guidelines\n\n${SEPTUM_RULES_TEMPLATE}\n`, "utf-8");
      console.log(`  ✓ Created onboarding instructions: '${options.rootDoc}'.`);
    } else if (force) {
      const existing = fs.readFileSync(rootDocPath, "utf-8");
      if (!existing.includes("septum_domain")) {
        fs.writeFileSync(rootDocPath, existing.trimEnd() + "\n\n" + SEPTUM_RULES_TEMPLATE + "\n", "utf-8");
        console.log(`  ✓ Appended Septum boundary rules to '${options.rootDoc}' (--force).`);
      }
    }
  }

  // 3. Shared Hook Scripts: <harnessDir>/hooks/septum-pre-write.sh & septum-post-write.sh
  ensureHarnessHookScripts(harnessDirName, cwd, force);
  console.log(`  ✓ Deployed lifecycle hook scripts in '${harnessDirName}/hooks/'.`);

  // 4. Hooks Config: <harnessDir>/hooks.json
  deployHarnessHooksJson(harnessDirName, cwd, force, outErrors);
}

export function deployHarnessHooksJson(
  harnessDirName: string,
  cwd: string = process.cwd(),
  force: boolean = false,
  outErrors?: string[]
): void {
  const targetDir = path.join(cwd, harnessDirName);
  const hooksJsonPath = path.join(targetDir, "hooks.json");
  const hooksResult = readJsonConfigFile(hooksJsonPath);
  if (hooksResult.status === "malformed") {
    console.error(`  ✕ Error: Malformed JSON in '${harnessDirName}/hooks.json': ${hooksResult.error}. Preserving existing file without modification.`);
    if (outErrors) outErrors.push(`Malformed JSON in '${harnessDirName}/hooks.json': ${hooksResult.error}`);
    return;
  }

  const existingHooks = hooksResult.status === "valid" ? hooksResult.data : {};
  const mergedHooks: Record<string, any> = { ...existingHooks };

  for (const [namespace, events] of Object.entries(SEPTUM_HOOKS_CONFIG)) {
    if (!mergedHooks[namespace] || typeof mergedHooks[namespace] !== "object") {
      mergedHooks[namespace] = { ...events };
      continue;
    }

    const targetNs = { ...mergedHooks[namespace] };
    const hasAnyHookArray = Array.isArray(targetNs.PreToolUse) || Array.isArray(targetNs.PostToolUse);

    if (!force && !hasAnyHookArray && targetNs.user_override) {
      continue;
    }

    for (const [eventName, templateEntries] of Object.entries(events as Record<string, any[]>)) {
      const existingEntries = Array.isArray(targetNs[eventName]) ? [...targetNs[eventName]] : [];
      const isSeptumCommand = (cmd: unknown) =>
        typeof cmd === "string" && (cmd.includes("septum-pre-write") || cmd.includes("septum-post-write"));

      if (!force) {
        const hasManagedHook = existingEntries.some((entry: any) => {
          if (Array.isArray(entry?.hooks)) {
            return entry.hooks.some((h: any) => isSeptumCommand(h?.command));
          }
          return isSeptumCommand(entry?.command);
        });
        if (!hasManagedHook) {
          existingEntries.push(...templateEntries);
        }
      } else {
        const cleanedEntries: any[] = [];
        for (const entry of existingEntries) {
          if (Array.isArray(entry?.hooks)) {
            const userHooks = entry.hooks.filter((h: any) => !isSeptumCommand(h?.command));
            if (userHooks.length > 0) {
              cleanedEntries.push({ ...entry, hooks: userHooks });
            }
          } else if (isSeptumCommand(entry?.command)) {
            // Dedicated entry, omit
          } else if (!JSON.stringify(entry).includes("septum-pre-write") && !JSON.stringify(entry).includes("septum-post-write")) {
            cleanedEntries.push(entry);
          }
        }
        cleanedEntries.push(...templateEntries);
        targetNs[eventName] = cleanedEntries;
        continue;
      }
      targetNs[eventName] = existingEntries;
    }
    mergedHooks[namespace] = targetNs;
  }

  writeJsonFile(hooksJsonPath, mergedHooks);
  console.log(`  ✓ Configured AI Agent lifecycle hooks: '${harnessDirName}/hooks.json'.`);
}

export function ensureHarnessHookScripts(
  harnessDirName: string,
  cwd: string = process.cwd(),
  force: boolean = false
): { preWrite: string; postWrite: string } {
  const hooksDir = path.join(cwd, harnessDirName, "hooks");
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const preWriteHook = path.join(hooksDir, "septum-pre-write.sh");
  if (!fs.existsSync(preWriteHook) || force) {
    fs.writeFileSync(preWriteHook, SEPTUM_PRE_WRITE_SCRIPT, "utf-8");
  }
  try {
    const stat = fs.statSync(preWriteHook);
    if ((stat.mode & 0o111) === 0 || force) {
      fs.chmodSync(preWriteHook, 0o755);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Notice: Could not set executable permission on '${preWriteHook}': ${message}`);
  }

  const postWriteHook = path.join(hooksDir, "septum-post-write.sh");
  if (!fs.existsSync(postWriteHook) || force) {
    fs.writeFileSync(postWriteHook, SEPTUM_POST_WRITE_SCRIPT, "utf-8");
  }
  try {
    const stat = fs.statSync(postWriteHook);
    if ((stat.mode & 0o111) === 0 || force) {
      fs.chmodSync(postWriteHook, 0o755);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Notice: Could not set executable permission on '${postWriteHook}': ${message}`);
  }

  return { preWrite: preWriteHook, postWrite: postWriteHook };
}

// Backward-compatibility wrapper for Antigravity (.gemini)
export function ensureSharedHookScripts(cwd: string, force: boolean = false): { preWrite: string; postWrite: string } {
  return ensureHarnessHookScripts(".gemini", cwd, force);
}

// Backward-compatibility wrapper for Antigravity (.gemini)
export function scaffoldAgentCustomizations(cwd: string, force: boolean = false, outErrors?: string[]): void {
  scaffoldHarnessCustomizations(".gemini", cwd, force, outErrors, { includeRules: true });
}

export function appendTomlMcpServer(
  tomlPath: string,
  serverName: string,
  command: string,
  args: string[],
  force: boolean = false
): void {
  let existingContent = "";
  if (fs.existsSync(tomlPath)) {
    existingContent = fs.readFileSync(tomlPath, "utf-8");
  }

  const tableHeader = `[mcp_servers.${serverName}]`;
  const formattedArgs = JSON.stringify(args);
  const block = `\n${tableHeader}\ncommand = "${command}"\nargs = ${formattedArgs}\n`;

  const mcpServersKeyPattern = `(?:"mcp_servers"|'mcp_servers'|mcp_servers)`;
  const serverKeyPattern = `(?:"${serverName}"|'${serverName}'|${serverName})`;
  const activeTableHeaderRegex = new RegExp(
    `^[ \\t]*\\[[ \\t]*${mcpServersKeyPattern}[ \\t]*\\.[ \\t]*${serverKeyPattern}[ \\t]*\\][ \\t]*(?:#.*)?$`,
    "m"
  );
  const hasActiveTable = activeTableHeaderRegex.test(existingContent);

  if (hasActiveTable) {
    if (force) {
      const sectionRegex = new RegExp(
        `(?:^|\\n)[ \\t]*\\[[ \\t]*${mcpServersKeyPattern}[ \\t]*\\.[ \\t]*${serverKeyPattern}[ \\t]*\\][ \\t]*(?:#.*)?\\r?\\n[\\s\\S]*?(?=\\r?\\n[ \\t]*\\[|$)`
      );
      if (sectionRegex.test(existingContent)) {
        const updated = existingContent.replace(
          sectionRegex,
          `\n${tableHeader}\ncommand = "${command}"\nargs = ${formattedArgs}\n`
        );
        fs.writeFileSync(tomlPath, updated.trimStart(), "utf-8");
        return;
      }
    }
    return;
  }

  fs.writeFileSync(tomlPath, (existingContent.trim() ? existingContent.trim() + "\n" : "") + block, "utf-8");
}
