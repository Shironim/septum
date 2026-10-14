import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { handleIngestCommand } from "./ingest.ts";
import { TopologyDetector } from "../../core/discovery/topology-detector.ts";
import { EnvironmentDetector } from "../../core/topology/environment-detector.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { ConfigLoader } from "../../core/config/loader.ts";

import { promptSelectHarnesses } from "../ui/prompts.ts";
import { configureHarness, SUPPORTED_HARNESSES } from "../scaffold/harness-config.ts";

export async function handleInitCommand(force: boolean = false): Promise<void> {
  const cwd = process.cwd();
  const dbPath = ".septum/septum.db";

  console.log("\n\x1b[36m◆\x1b[0m  \x1b[1mSeptum Architecture Guard & SSOT Initializer\x1b[0m\n\x1b[36m│\x1b[0m");

  // 1. Auto-discover project topology and persist to SQLite SSOT
  console.log("\x1b[36m◇\x1b[0m  Analyzing codebase topology, modular boundaries, and 6-layer environment plane...");
  const db = new SeptumDatabase(dbPath);
  try {
    const repo = new SeptumRepository(db.raw);
    const domains = TopologyDetector.discoverAndPersist(repo, cwd);
    EnvironmentDetector.detect(cwd, repo);
    const domainNames = Object.keys(domains);
    console.log(`\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Discovered and registered ${domainNames.length} domain(s) in SQLite:`);
    for (const name of domainNames) {
      console.log(`\x1b[36m│\x1b[0m    - \x1b[1m${name}\x1b[0m: root -> '${domains[name].root}'`);
    }
  } finally {
    db.close();
  }
  console.log("\x1b[36m│\x1b[0m");

  // 2. Interactive AI Agent Harness Selection
  const selectedHarnesses = await promptSelectHarnesses(SUPPORTED_HARNESSES);

  // 3. Configure local project artifacts
  const forceNotice = force ? " (force regeneration of Septum-owned artifacts)" : "";
  console.log(`\x1b[36m◇\x1b[0m  Scaffolding project-local guards & harness configurations${forceNotice}...`);
  ensureGitIgnore(cwd);
  const hookResult = installGitHook(cwd, force);

  const configuredFiles: string[] = [];
  for (const harnessId of selectedHarnesses) {
    const file = configureHarness(harnessId, cwd, force);
    if (file) configuredFiles.push(file);
  }
  if (configuredFiles.length > 0) {
    console.log(`\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Configured local harness artifacts for: ${configuredFiles.join(", ")}`);
  }
  console.log("\x1b[36m│\x1b[0m");

  // 4. Run initial codebase ingestion
  console.log("\x1b[36m◇\x1b[0m  Running initial Tree-Sitter AST ingestion to build symbol & dependency catalog...");
  try {
    await handleIngestCommand();
    console.log("\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Ingestion completed successfully.");
    console.log("\x1b[36m│\x1b[0m");

    // Inspect index coverage & unindexed files from SSOT
    let unsupportedFiles: string[] = [];
    let skippedFiles: Array<{ path: string; reason: string }> = [];
    let enforcementMode = "warn";
    const statusDb = new SeptumDatabase(dbPath);
    try {
      const statusRepo = new SeptumRepository(statusDb.raw);
      unsupportedFiles = JSON.parse(statusRepo.getMeta("unsupported_files") || "[]");
      skippedFiles = JSON.parse(statusRepo.getMeta("skipped_files") || "[]");
      const loadedConfig = ConfigLoader.loadFromRepository(statusRepo);
      enforcementMode = loadedConfig.settings.enforcement || "warn";
    } finally {
      statusDb.close();
    }

    const hasPartialCoverage = unsupportedFiles.length > 0 || skippedFiles.length > 0;
    if (hasPartialCoverage) {
      console.log("\x1b[33m└  ⚠ Septum initialized with partial index coverage (see unindexed files below)\x1b[0m");
      if (unsupportedFiles.length > 0) {
        console.log(`   • Unsupported parser/language (${unsupportedFiles.length} file(s)): ${unsupportedFiles.slice(0, 5).join(", ")}${unsupportedFiles.length > 5 ? "..." : ""}`);
      }
      if (skippedFiles.length > 0) {
        console.log(`   • Exceeded resource limits (${skippedFiles.length} file(s) > 2 MiB): ${skippedFiles.map((f) => f.path).slice(0, 5).join(", ")}${skippedFiles.length > 5 ? "..." : ""}`);
      }
    } else {
      console.log("\x1b[32m└  ✓ Septum successfully initialized and ready for production use (full index coverage)!\x1b[0m");
    }

    if (hookResult.status === "installed" || hookResult.status === "already_installed" || hookResult.status === "updated") {
      const isStrict = enforcementMode === "strict";
      const modeLabel = isStrict ? "blocking (strict)" : "audit-only (warn)";
      console.log(`   • Pre-commit hook is active in ${modeLabel} mode (runs 'septum check --staged' before each commit).`);
      if (!isStrict) {
        console.log("     Notice: Default 'warn' mode logs boundary violations without blocking commits. Configure 'enforcement: strict' in configuration to block.");
      }
    } else if (hookResult.status === "preserved_user_hook") {
      console.log("   • Notice: Existing non-Septum pre-commit hook was preserved. Septum git hook is not active.");
    } else if (hookResult.status === "skipped_no_git") {
      console.log("   • Notice: Git pre-commit hook was skipped (no .git repository found).");
    }

    if (selectedHarnesses.includes("antigravity")) {
      console.log("   • AI Agent skills and boundary rules are active in '.gemini/'.");
    }
    console.log("   • MCP server is ready for AI coding agents via 'septum serve'.\n");
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    let failurePhase = "AST Ingestion Pipeline";
    let recoveryInstruction = "Inspect the error trace above, verify project settings, then run 'septum ingest' to resume indexing.";

    if (rawMessage.includes("Cannot load Septum configuration") || rawMessage.includes("JSON") || rawMessage.includes("schema")) {
      failurePhase = "Configuration Loading";
      recoveryInstruction = "Check and repair the configuration/metadata in '.septum/septum.db', then run 'septum ingest' to rebuild the symbol catalog.";
    } else if (rawMessage.includes("resource limit") || rawMessage.includes("exceeds")) {
      failurePhase = "Resource Limit";
      recoveryInstruction = "Configure ignore patterns in '.septum/septum.db' for oversized files, then run 'septum ingest'.";
    } else if (rawMessage.includes("database") || rawMessage.includes("SQLite") || rawMessage.includes("locked")) {
      failurePhase = "Database Access";
      recoveryInstruction = "Ensure no other process is locking '.septum/septum.db', then run 'septum ingest'.";
    } else if (rawMessage.includes("unsupported") || rawMessage.includes("degraded")) {
      failurePhase = "Parser";
      recoveryInstruction = "Review unsupported source files, then run 'septum ingest'.";
    }

    console.error(`\x1b[31m│\x1b[0m`);
    console.error(`\x1b[31m│\x1b[0m  \x1b[1;31m✕ Initial codebase ingestion failed (${failurePhase})\x1b[0m`);
    console.error(`\x1b[31m│\x1b[0m  \x1b[1mPartial Initialization State:\x1b[0m`);
    console.error(`\x1b[31m│\x1b[0m    ✓ Codebase topology & environment plane: Registered in SQLite SSOT`);
    console.error(`\x1b[31m│\x1b[0m    ✓ Harness configurations & project guards: Scaffolding complete`);
    if (hookResult.status === "installed" || hookResult.status === "already_installed" || hookResult.status === "updated") {
      console.error(`\x1b[31m│\x1b[0m    ✓ Git pre-commit hook: Installed & active`);
    } else if (hookResult.status === "preserved_user_hook") {
      console.error(`\x1b[31m│\x1b[0m    • Git pre-commit hook: Existing non-Septum hook preserved (Septum hook not active)`);
    } else {
      console.error(`\x1b[31m│\x1b[0m    - Git pre-commit hook: Skipped (no .git repository found)`);
    }
    console.error(`\x1b[31m│\x1b[0m    ✕ Symbol & dependency catalog: Incomplete`);
    console.error(`\x1b[31m│\x1b[0m`);
    console.error(`\x1b[31m│\x1b[0m  \x1b[1;31mError Details:\x1b[0m ${rawMessage}`);
    console.error(`\x1b[31m│\x1b[0m  \x1b[1;33mRecovery Instruction:\x1b[0m`);
    console.error(`\x1b[31m│\x1b[0m    ${recoveryInstruction}`);
    console.error(`\x1b[31m│\x1b[0m`);

    process.exitCode = 1;
    throw new Error(`Initial ingestion failed (${failurePhase}): ${rawMessage}. ${recoveryInstruction}`);
  }
}

export function ensureGitIgnore(cwd: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entriesToEnsure = [".septum/*.db*", ".septum/"];

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    const activeRules = new Set(
      content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"))
    );

    const missing = entriesToEnsure.filter((entry) => {
      if (activeRules.has(entry)) return false;
      if (
        entry === ".septum/" &&
        (activeRules.has(".septum") || activeRules.has("/.septum") || activeRules.has("/.septum/"))
      ) {
        return false;
      }
      return true;
    });

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

export interface GitHookInstallResult {
  status: "installed" | "already_installed" | "updated" | "preserved_user_hook" | "skipped_no_git";
  path?: string;
  message: string;
}

export function installGitHook(cwd: string, force: boolean = false): GitHookInstallResult {
  const gitDir = path.join(cwd, ".git");
  if (!fs.existsSync(gitDir)) {
    console.log("  ⚠ No .git directory found. Skipping pre-commit hook installation.");
    return {
      status: "skipped_no_git",
      message: "No .git directory found. Skipping pre-commit hook installation.",
    };
  }

  const huskyDir = path.join(cwd, ".husky");
  if (fs.existsSync(huskyDir)) {
    const huskyPreCommit = path.join(huskyDir, "pre-commit");
    const hookCommand = `# Septum deterministic boundary pre-commit hook
if [ -f "./bin/septum.ts" ] && command -v bun >/dev/null 2>&1; then
  bun run ./bin/septum.ts check --staged || exit $?
elif command -v septum >/dev/null 2>&1; then
  septum check --staged || exit $?
elif [ -f "./node_modules/.bin/septum" ]; then
  ./node_modules/.bin/septum check --staged || exit $?
elif command -v bunx >/dev/null 2>&1; then
  bunx septum check --staged || exit $?
fi`;
    let huskyStatus: "installed" | "updated" | "already_installed" = "installed";
    if (fs.existsSync(huskyPreCommit)) {
      const existing = fs.readFileSync(huskyPreCommit, "utf-8");
      if (!existing.includes("septum check") && !existing.includes("Septum deterministic boundary pre-commit hook")) {
        fs.appendFileSync(huskyPreCommit, `\n${hookCommand}\n`, "utf-8");
        huskyStatus = "updated";
      } else if (force) {
        const septumBlockRegex = /# Septum deterministic boundary pre-commit hook[\s\S]*?\nfi/m;
        if (septumBlockRegex.test(existing)) {
          const updated = existing.replace(septumBlockRegex, hookCommand);
          fs.writeFileSync(huskyPreCommit, updated, "utf-8");
        }
        try {
          fs.chmodSync(huskyPreCommit, 0o755);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`  Notice: Could not set executable permission on '${huskyPreCommit}': ${message}`);
        }
        huskyStatus = "updated";
      } else {
        huskyStatus = "already_installed";
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
    return {
      status: huskyStatus,
      path: huskyPreCommit,
      message: "Configured pre-commit hook in .husky/pre-commit.",
    };
  }

function resolveGitHooksDir(cwd: string): string {
  const gitEntry = path.join(cwd, ".git");

  // 1. Try resolving using git rev-parse --git-path hooks
  try {
    const rawPath = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (rawPath) {
      return path.resolve(cwd, rawPath);
    }
  } catch {
    // Git CLI failed or not available in PATH; proceed with fallback
  }

  // 2. Filesystem fallback: inspect .git entry
  try {
    const stat = fs.statSync(gitEntry);
    if (stat.isDirectory()) {
      return path.join(gitEntry, "hooks");
    }
    if (stat.isFile()) {
      const gitContent = fs.readFileSync(gitEntry, "utf-8");
      const match = gitContent.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const gitDirTarget = path.resolve(cwd, match[1].trim());
        const commondirFile = path.join(gitDirTarget, "commondir");
        if (fs.existsSync(commondirFile)) {
          const commonRel = fs.readFileSync(commondirFile, "utf-8").trim();
          return path.join(path.resolve(gitDirTarget, commonRel), "hooks");
        }
        return path.join(gitDirTarget, "hooks");
      }
    }
  } catch {
    // Ignore fallback errors
  }

  return path.join(gitEntry, "hooks");
}

  const hooksDir = resolveGitHooksDir(cwd);
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const preCommitHook = path.join(hooksDir, "pre-commit");
  const displayPath = path.relative(cwd, preCommitHook);
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

  if (fs.existsSync(preCommitHook)) {
    const existingContent = fs.readFileSync(preCommitHook, "utf-8");
    const isSeptumHook =
      existingContent.includes("Septum deterministic boundary pre-commit hook") ||
      existingContent.includes("septum check --staged");

    if (!isSeptumHook) {
      console.warn(`  ⚠ Existing non-Septum pre-commit hook detected at '${displayPath}'. Preserving existing hook.`);
      return {
        status: "preserved_user_hook",
        path: preCommitHook,
        message: `Existing non-Septum pre-commit hook detected at '${displayPath}'. Preserving existing hook.`,
      };
    }

    if (existingContent.trim() === hookScript.trim() && !force) {
      console.log(`  ✓ Septum pre-commit hook is already installed at '${displayPath}'.`);
      return {
        status: "already_installed",
        path: preCommitHook,
        message: `Septum pre-commit hook is already installed at '${displayPath}'.`,
      };
    }

    fs.writeFileSync(preCommitHook, hookScript, "utf-8");
    try {
      fs.chmodSync(preCommitHook, 0o755);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  Notice: Could not set executable permission on '${preCommitHook}': ${message}`);
    }
    const actionDesc = force ? "Force-regenerated" : "Updated";
    console.log(`  ✓ ${actionDesc} Septum pre-commit hook at '${displayPath}'${force ? " (--force)" : ""}.`);
    return {
      status: "updated",
      path: preCommitHook,
      message: `${actionDesc} Septum pre-commit hook at '${displayPath}'.`,
    };
  }

  fs.writeFileSync(preCommitHook, hookScript, "utf-8");
  try {
    fs.chmodSync(preCommitHook, 0o755);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Notice: Could not set executable permission on '${preCommitHook}': ${message}`);
  }
  console.log(`  ✓ Installed executable git pre-commit hook at '${displayPath}'.`);
  return {
    status: "installed",
    path: preCommitHook,
    message: `Installed executable git pre-commit hook at '${displayPath}'.`,
  };
}
