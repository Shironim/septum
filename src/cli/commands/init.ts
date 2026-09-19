import * as fs from "node:fs";
import * as path from "node:path";
import { handleIngestCommand } from "./ingest.ts";
import {
  SEPTUM_HOOKS_CONFIG,
  SEPTUM_POST_WRITE_SCRIPT,
  SEPTUM_PRE_WRITE_SCRIPT,
} from "../templates/hooks.ts";
import { SEPTUM_RULES_TEMPLATE } from "../templates/rules.ts";
import { SEPTUM_MAP_SKILL_TEMPLATE } from "../templates/skill.ts";
import { TopologyDetector } from "../../core/discovery/topology-detector.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";

export async function handleInitCommand(force: boolean = false): Promise<void> {
  console.log("[Septum] Initializing Septum bounded-context environment (Zero-Config)...\n");

  const cwd = process.cwd();
  const dbPath = ".septum/septum.db";

  // 1. Auto-discover project topology and persist to SQLite SSOT
  console.log("  • Analyzing codebase topology and modular boundaries...");
  const db = new SeptumDatabase(dbPath);
  const repo = new SeptumRepository(db.raw);
  const domains = TopologyDetector.discoverAndPersist(repo, cwd);
  const domainNames = Object.keys(domains);
  console.log(`  ✓ Discovered and registered ${domainNames.length} domains directly in SQLite (${dbPath}):`);
  for (const name of domainNames) {
    console.log(`    - ${name}: root -> '${domains[name].root}'`);
  }
  db.close();

  // 2. Ensure .gitignore excludes local SQLite cache
  ensureGitIgnore(cwd);

  // 3. Install Git Pre-Commit Hook
  installGitHook(cwd);

  // 4. Scaffold Agent Customizations (.agents/skills, .agents/hooks, .agents/rules)
  scaffoldAgentCustomizations(cwd);

  // 5. Run initial codebase ingestion
  console.log("\n[Septum] Running initial ingestion to build deterministic structural catalog...");
  try {
    await handleIngestCommand();
    console.log("\n✓ Septum successfully initialized and ready for production use!");
    console.log("  • Pre-commit hook is active (runs 'septum check --staged' before each commit).");
    console.log("  • AI Agent skill '/septum-map' and boundary hooks installed in '.agents/'.");
    console.log("  • MCP server is ready for AI coding agents via 'septum serve'.\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`\n[Septum Warning] Initial ingestion encountered an error: ${message}`);
    console.warn("Run 'septum ingest' manually to retry.");
  }
}

function ensureGitIgnore(cwd: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entriesToEnsure = [".septum/*.db*", ".septum/"];

  if (fs.existsSync(gitignorePath)) {
    let content = fs.readFileSync(gitignorePath, "utf-8");
    const missing = entriesToEnsure.filter((entry) => !content.includes(entry));

    if (missing.length > 0) {
      const addition = `\n# Septum local database and cache\n${missing.join("\n")}\n`;
      fs.appendFileSync(gitignorePath, addition, "utf-8");
      console.log("  ✓ Updated .gitignore to exclude local SQLite cache (.septum/).");
    } else {
      console.log("  ✓ .gitignore already configured for Septum.");
    }
  } else {
    fs.writeFileSync(
      gitignorePath,
      `# Septum local database and cache\n${entriesToEnsure.join("\n")}\n`,
      "utf-8"
    );
    console.log("  ✓ Created .gitignore excluding local SQLite cache (.septum/).");
  }
}

function installGitHook(cwd: string): void {
  const gitDir = path.join(cwd, ".git");
  if (!fs.existsSync(gitDir)) {
    console.log("  ⚠ No .git directory found. Skipping pre-commit hook installation.");
    return;
  }

  const huskyDir = path.join(cwd, ".husky");
  if (fs.existsSync(huskyDir)) {
    const huskyPreCommit = path.join(huskyDir, "pre-commit");
    const hookCommand = "[ -f ./bin/septum.ts ] && bun run ./bin/septum.ts check --staged || command -v septum >/dev/null 2>&1 && septum check --staged || [ -f ./node_modules/.bin/septum ] && ./node_modules/.bin/septum check --staged || bunx septum check --staged";
    if (fs.existsSync(huskyPreCommit)) {
      const existing = fs.readFileSync(huskyPreCommit, "utf-8");
      if (!existing.includes("septum check")) {
        fs.appendFileSync(huskyPreCommit, `\n${hookCommand}\n`, "utf-8");
      }
    } else {
      fs.writeFileSync(huskyPreCommit, `#!/usr/bin/env sh\n${hookCommand}\n`, "utf-8");
      try {
        fs.chmodSync(huskyPreCommit, 0o755);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`  Notice: Could not set executable permission on '${huskyPreCommit}': ${message}`);
      }
    }
    console.log("  ✓ Installed pre-commit hook in .husky/pre-commit.");
    return;
  }

  const hooksDir = path.join(gitDir, "hooks");
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const preCommitHook = path.join(hooksDir, "pre-commit");
  const hookScript = `#!/usr/bin/env sh
# Septum deterministic boundary pre-commit hook
echo "[Septum Hook] Auditing staged changes against domain boundaries..."

if command -v bun >/dev/null 2>&1 && [ -f "./bin/septum.ts" ]; then
  bun run ./bin/septum.ts check --staged
elif command -v septum >/dev/null 2>&1; then
  septum check --staged
elif [ -f "./node_modules/.bin/septum" ]; then
  ./node_modules/.bin/septum check --staged
elif command -v bunx >/dev/null 2>&1; then
  bunx septum check --staged
else
  echo "[Septum Hook] Notice: Septum executable not found. Skipping boundary check."
fi
`;

  fs.writeFileSync(preCommitHook, hookScript, "utf-8");
  try {
    fs.chmodSync(preCommitHook, 0o755);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Notice: Could not set executable permission on '${preCommitHook}': ${message}`);
  }
  console.log("  ✓ Installed executable git pre-commit hook at '.git/hooks/pre-commit'.");
}

function scaffoldAgentCustomizations(cwd: string): void {
  const agentsDir = path.join(cwd, ".agents");

  // 1. Skill: .agents/skills/septum-map/SKILL.md
  const skillDir = path.join(agentsDir, "skills", "septum-map");
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, SEPTUM_MAP_SKILL_TEMPLATE, "utf-8");
  console.log("  ✓ Deployed AI Agent skill: '.agents/skills/septum-map/SKILL.md'.");

  // 2. Rule: .agents/rules/septum-boundary.md
  const rulesDir = path.join(agentsDir, "rules");
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
  const rulePath = path.join(rulesDir, "septum-boundary.md");
  fs.writeFileSync(rulePath, SEPTUM_RULES_TEMPLATE, "utf-8");
  console.log("  ✓ Deployed AI Agent boundary rules: '.agents/rules/septum-boundary.md'.");

  // 3. Hook Script: .agents/hooks/septum-pre-write.sh
  const hooksDir = path.join(agentsDir, "hooks");
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }
  const preWriteHook = path.join(hooksDir, "septum-pre-write.sh");
  fs.writeFileSync(preWriteHook, SEPTUM_PRE_WRITE_SCRIPT, "utf-8");
  try {
    fs.chmodSync(preWriteHook, 0o755);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Notice: Could not set executable permission on '${preWriteHook}': ${message}`);
  }
  console.log("  ✓ Deployed pre-write hook script: '.agents/hooks/septum-pre-write.sh'.");

  // 3b. Post-Write Hook Script: .agents/hooks/septum-post-write.sh
  const postWriteHook = path.join(hooksDir, "septum-post-write.sh");
  fs.writeFileSync(postWriteHook, SEPTUM_POST_WRITE_SCRIPT, "utf-8");
  try {
    fs.chmodSync(postWriteHook, 0o755);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Notice: Could not set executable permission on '${postWriteHook}': ${message}`);
  }
  console.log("  ✓ Deployed post-write hook script: '.agents/hooks/septum-post-write.sh'.");

  // 4. Hooks Config: .agents/hooks.json
  const hooksJsonPath = path.join(agentsDir, "hooks.json");
  let existingHooks: Record<string, unknown> = {};

  if (fs.existsSync(hooksJsonPath)) {
    try {
      const raw = fs.readFileSync(hooksJsonPath, "utf-8");
      existingHooks = JSON.parse(raw);
    } catch {
      // Malformed JSON fallback
    }
  }

  const mergedHooks = {
    ...existingHooks,
    ...SEPTUM_HOOKS_CONFIG,
  };

  fs.writeFileSync(hooksJsonPath, JSON.stringify(mergedHooks, null, 2) + "\n", "utf-8");
  console.log("  ✓ Configured AI Agent lifecycle hooks: '.agents/hooks.json'.");
}
