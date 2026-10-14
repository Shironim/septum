import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
    id: "claude",
    name: "Claude Code",
    targetFile: ".mcp.json & .claude/settings.json",
    description: "Standard project-local MCP & lifecycle hook guard for Claude Code",
    selectedByDefault: true,
  },
  {
    id: "antigravity",
    name: "Antigravity",
    targetFile: ".gemini/ (skills, rules, hooks, mcp)",
    description: "Local skills, rules, hooks, and MCP config for Antigravity AI agents",
    selectedByDefault: true,
  },
  {
    id: "opencode",
    name: "Opencode",
    targetFile: "opencode.json",
    description: "Project configuration for Opencode AI harness",
    selectedByDefault: false,
  },
  {
    id: "cursor",
    name: "Cursor",
    targetFile: ".cursor/mcp.json & .cursor/hooks.json",
    description: "Local MCP & lifecycle hook guard for Cursor IDE",
    selectedByDefault: false,
  },
  {
    id: "codex",
    name: "Codex",
    targetFile: ".codex/config.toml & .codex/hooks.json",
    description: "Project workspace config & hook guard for OpenAI Codex CLI",
    selectedByDefault: false,
  },
  {
    id: "goose",
    name: "Goose",
    targetFile: ".goose/config.yaml",
    description: "Extension config template for Block Goose",
    selectedByDefault: false,
  },
  {
    id: "pi",
    name: "Pi / Oh My Pi",
    targetFile: ".pi/mcp.json",
    description: "Local MCP configuration for Pi agent workflows",
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

export function readYamlConfigFile<T = Record<string, any>>(filePath: string): ConfigReadResult<T> {
  if (!fs.existsSync(filePath)) return { status: "missing" };
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    const parsed = parseYaml(raw);
    if (parsed === null || parsed === undefined) {
      return { status: "valid", data: {} as T };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        status: "malformed",
        error: `Expected YAML mapping root, found ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        raw,
      };
    }
    return { status: "valid", data: parsed as T };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "malformed",
      error: `Malformed YAML syntax: ${message}`,
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
    case "claude": {
      const configured: string[] = [];

      // 1. MCP config in .mcp.json
      const configPath = path.join(cwd, ".mcp.json");
      const mcpResult = readJsonConfigFile(configPath);
      if (mcpResult.status === "malformed") {
        console.error(`  ✕ Error: Malformed JSON in '.mcp.json': ${mcpResult.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed JSON in '.mcp.json': ${mcpResult.error}`);
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
        configured.push(".mcp.json");
      }

      // 2. Lifecycle hooks in .claude/settings.json
      ensureSharedHookScripts(cwd, force);
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
                "sh -c 'ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\"; if [ -f \"$ROOT/.gemini/hooks/septum-pre-write.sh\" ]; then exec \"$ROOT/.gemini/hooks/septum-pre-write.sh\" --exit-code-2; elif [ -f \"$ROOT/.agents/hooks/septum-pre-write.sh\" ]; then exec \"$ROOT/.agents/hooks/septum-pre-write.sh\" --exit-code-2; else exit 0; fi'",
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

    case "cursor": {
      const configured: string[] = [];

      // 1. MCP config in .cursor/mcp.json
      const configPath = path.join(cwd, ".cursor", "mcp.json");
      const mcpResult = readJsonConfigFile(configPath);
      if (mcpResult.status === "malformed") {
        console.error(`  ✕ Error: Malformed JSON in '.cursor/mcp.json': ${mcpResult.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed JSON in '.cursor/mcp.json': ${mcpResult.error}`);
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
        configured.push(".cursor/mcp.json");
      }

      // 2. Lifecycle hooks in .cursor/hooks.json
      ensureSharedHookScripts(cwd, force);
      const cursorHooksPath = path.join(cwd, ".cursor", "hooks.json");
      const hooksResult = readJsonConfigFile(cursorHooksPath);
      if (hooksResult.status === "malformed") {
        console.error(`  ✕ Error: Malformed JSON in '.cursor/hooks.json': ${hooksResult.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed JSON in '.cursor/hooks.json': ${hooksResult.error}`);
      } else {
        const cursorHooksConfig = hooksResult.status === "valid" ? hooksResult.data : { version: 1, hooks: {} };
        cursorHooksConfig.version = cursorHooksConfig.version || 1;
        cursorHooksConfig.hooks = (typeof cursorHooksConfig.hooks === "object" && cursorHooksConfig.hooks !== null && !Array.isArray(cursorHooksConfig.hooks))
          ? cursorHooksConfig.hooks
          : {};
        const preToolUse = Array.isArray(cursorHooksConfig.hooks.preToolUse) ? cursorHooksConfig.hooks.preToolUse : [];

        const hasSeptumHook = preToolUse.some((h: any) => {
          if (Array.isArray(h?.hooks)) {
            return h.hooks.some((hk: any) => typeof hk?.command === "string" && hk.command.includes("septum-pre-write"));
          }
          return typeof h?.command === "string" && h.command.includes("septum-pre-write");
        });
        const canonicalHook = {
          matcher: "Write|Edit",
          command:
            "sh -c 'ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\"; if [ -f \"$ROOT/.gemini/hooks/septum-pre-write.sh\" ]; then exec \"$ROOT/.gemini/hooks/septum-pre-write.sh\" --exit-code-2; elif [ -f \"$ROOT/.agents/hooks/septum-pre-write.sh\" ]; then exec \"$ROOT/.agents/hooks/septum-pre-write.sh\" --exit-code-2; else exit 0; fi'",
          failClosed: true,
        };
        if (!hasSeptumHook) {
          preToolUse.push(canonicalHook);
          cursorHooksConfig.hooks.preToolUse = preToolUse;
          writeJsonFile(cursorHooksPath, cursorHooksConfig);
          console.log("  ✓ Configured Cursor IDE lifecycle boundary guard: '.cursor/hooks.json'.");
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
          cursorHooksConfig.hooks.preToolUse = cleanedHooks;
          writeJsonFile(cursorHooksPath, cursorHooksConfig);
          console.log("  ✓ Force-regenerated Cursor IDE lifecycle boundary guard: '.cursor/hooks.json' (--force).");
        }
        configured.push(".cursor/hooks.json");
      }

      return configured.length > 0 ? configured.join(" & ") : null;
    }

    case "opencode": {
      const configPath = path.join(cwd, "opencode.json");
      const result = readJsonConfigFile(configPath);
      if (result.status === "malformed") {
        console.error(`  ✕ Error: Malformed JSON in 'opencode.json': ${result.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed JSON in 'opencode.json': ${result.error}`);
        return null;
      }
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
      }
      return "opencode.json";
    }

    case "codex": {
      const configured: string[] = [];

      // 1. MCP config in .codex/config.toml
      const codexDir = path.join(cwd, ".codex");
      if (!fs.existsSync(codexDir)) {
        fs.mkdirSync(codexDir, { recursive: true });
      }
      const configTomlPath = path.join(codexDir, "config.toml");
      appendTomlMcpServer(configTomlPath, "septum", "septum", ["serve"], force);
      configured.push(".codex/config.toml");

      // 2. Lifecycle hooks in .codex/hooks.json
      ensureSharedHookScripts(cwd, force);
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
                "sh -c 'ROOT=\"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\"; if [ -f \"$ROOT/.gemini/hooks/septum-pre-write.sh\" ]; then exec \"$ROOT/.gemini/hooks/septum-pre-write.sh\" --exit-code-2; elif [ -f \"$ROOT/.agents/hooks/septum-pre-write.sh\" ]; then exec \"$ROOT/.agents/hooks/septum-pre-write.sh\" --exit-code-2; else exit 0; fi'",
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

    case "pi": {
      const configPath = path.join(cwd, ".pi", "mcp.json");
      const result = readJsonConfigFile(configPath);
      if (result.status === "malformed") {
        console.error(`  ✕ Error: Malformed JSON in '.pi/mcp.json': ${result.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed JSON in '.pi/mcp.json': ${result.error}`);
        return null;
      }
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
        writeJsonFile(configPath, existing);
      }
      return ".pi/mcp.json";
    }

    case "goose": {
      const configPath = path.join(cwd, ".goose", "config.yaml");
      const yamlResult = readYamlConfigFile(configPath);
      if (yamlResult.status === "malformed") {
        console.error(`  ✕ Error: Malformed YAML in '.goose/config.yaml': ${yamlResult.error}. Preserving existing file without modification.`);
        if (outErrors) outErrors.push(`Malformed YAML in '.goose/config.yaml': ${yamlResult.error}`);
        return null;
      }
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const parsed: Record<string, any> = yamlResult.status === "valid" ? yamlResult.data : {};
      parsed.extensions = (typeof parsed.extensions === "object" && parsed.extensions !== null && !Array.isArray(parsed.extensions))
        ? parsed.extensions
        : {};
      if (!parsed.extensions.septum || force) {
        parsed.extensions.septum = {
          name: "septum",
          cmd: "septum",
          args: ["serve"],
          type: "stdio",
        };
        fs.writeFileSync(configPath, stringifyYaml(parsed), "utf-8");
      }
      console.log(
        "  \x1b[33mℹ Notice for Block Goose:\x1b[0m Generated project template at '.goose/config.yaml'.\n" +
          "    Goose CLI reads configuration from '~/.config/goose/config.yaml' (or %APPDATA%\\Block\\goose\\config\\config.yaml).\n" +
          "    Please run 'goose configure' or merge the extension block into your user config."
      );
      return ".goose/config.yaml";
    }

    case "antigravity": {
      // Antigravity artifacts placed strictly in .gemini/
      scaffoldAgentCustomizations(cwd, force, outErrors);

      const geminiDir = path.join(cwd, ".gemini");
      if (!fs.existsSync(geminiDir)) {
        fs.mkdirSync(geminiDir, { recursive: true });
      }
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

    default:
      return null;
  }
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

export function ensureSharedHookScripts(cwd: string, force: boolean = false): { preWrite: string; postWrite: string } {
  // Use .gemini/hooks/ as primary home for hook scripts
  const hooksDir = path.join(cwd, ".gemini", "hooks");
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

export function scaffoldAgentCustomizations(cwd: string, force: boolean = false, outErrors?: string[]): void {
  const geminiDir = path.join(cwd, ".gemini");

  // 1. Skill: .gemini/skills/septum-map/SKILL.md
  const skillDir = path.join(geminiDir, "skills", "septum-map");
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }
  const skillPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    fs.writeFileSync(skillPath, SEPTUM_MAP_SKILL_TEMPLATE, "utf-8");
    console.log("  ✓ Deployed AI Agent skill: '.gemini/skills/septum-map/SKILL.md'.");
  } else {
    const existing = fs.readFileSync(skillPath, "utf-8");
    if (existing === SEPTUM_MAP_SKILL_TEMPLATE) {
      // Unchanged
    } else if (force) {
      fs.writeFileSync(skillPath, SEPTUM_MAP_SKILL_TEMPLATE, "utf-8");
      console.log("  ✓ Updated AI Agent skill: '.gemini/skills/septum-map/SKILL.md' (--force).");
    } else {
      console.log("  ✓ Preserved existing customized AI Agent skill: '.gemini/skills/septum-map/SKILL.md'.");
    }
  }

  // 2. Rule: .gemini/rules/septum-boundary.md
  const rulesDir = path.join(geminiDir, "rules");
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
  const rulePath = path.join(rulesDir, "septum-boundary.md");
  if (!fs.existsSync(rulePath)) {
    fs.writeFileSync(rulePath, SEPTUM_RULES_TEMPLATE, "utf-8");
    console.log("  ✓ Deployed AI Agent boundary rules: '.gemini/rules/septum-boundary.md'.");
  } else {
    const existing = fs.readFileSync(rulePath, "utf-8");
    if (existing === SEPTUM_RULES_TEMPLATE) {
      // Unchanged
    } else if (force) {
      fs.writeFileSync(rulePath, SEPTUM_RULES_TEMPLATE, "utf-8");
      console.log("  ✓ Updated AI Agent boundary rules: '.gemini/rules/septum-boundary.md' (--force).");
    } else {
      console.log("  ✓ Preserved existing customized AI Agent boundary rules: '.gemini/rules/septum-boundary.md'.");
    }
  }

  // 3. Shared Hook Scripts: .gemini/hooks/septum-pre-write.sh & septum-post-write.sh
  ensureSharedHookScripts(cwd, force);
  console.log("  ✓ Deployed lifecycle hook scripts in '.gemini/hooks/'.");

  // 4. Hooks Config: .gemini/hooks.json
  const hooksJsonPath = path.join(geminiDir, "hooks.json");
  const hooksResult = readJsonConfigFile(hooksJsonPath);
  if (hooksResult.status === "malformed") {
    console.error(`  ✕ Error: Malformed JSON in '.gemini/hooks.json': ${hooksResult.error}. Preserving existing file without modification.`);
    if (outErrors) outErrors.push(`Malformed JSON in '.gemini/hooks.json': ${hooksResult.error}`);
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
      // Explicit user override without hook arrays: preserve as-is
      continue;
    }

    for (const [eventName, templateEntries] of Object.entries(events as Record<string, any[]>)) {
      const existingEntries = Array.isArray(targetNs[eventName]) ? [...targetNs[eventName]] : [];
      const isSeptumCommand = (cmd: unknown) =>
        typeof cmd === "string" && (cmd.includes("septum-pre-write") || cmd.includes("septum-post-write"));

      if (!force) {
        // Normal mode: add template entry if not already present, preserving all existing user entries
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
        // Force mode: strip only Septum hook commands, preserve user commands/entries, then add canonical
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

  fs.writeFileSync(hooksJsonPath, JSON.stringify(mergedHooks, null, 2) + "\n", "utf-8");
  console.log("  ✓ Configured AI Agent lifecycle hooks: '.gemini/hooks.json'.");
}

