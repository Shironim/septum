import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { handleSyncCommand } from "./sync.ts";
import { TopologyDetector } from "../../core/discovery/topology-detector.ts";
import { EnvironmentDetector } from "../../core/topology/environment-detector.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { ConfigLoader } from "../../core/config/loader.ts";
import { resolveWorkspaceRoot } from "../../core/resolver/path-resolver.ts";

import { promptSelectHarnesses } from "../ui/prompts.ts";
import { configureHarness, SUPPORTED_HARNESSES } from "../scaffold/harness-config.ts";

export async function handleInitCommand(force: boolean = false): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot();
  const septumDir = path.join(workspaceRoot, ".septum");
  if (!fs.existsSync(septumDir)) {
    fs.mkdirSync(septumDir, { recursive: true });
  }
  const dbPath = path.join(workspaceRoot, ".septum", "septum.db");

  console.log("\n\x1b[36m◆\x1b[0m  \x1b[1mSeptum Architecture Guard & SSOT Initializer\x1b[0m\n\x1b[36m│\x1b[0m");

  // 1. Auto-discover project topology and persist to SQLite SSOT
  console.log("\x1b[36m◇\x1b[0m  Analyzing codebase topology, modular boundaries, and deployment infrastructure...");
  const db = new SeptumDatabase(dbPath);
  try {
    const repo = new SeptumRepository(db.raw);
    const domains = TopologyDetector.discoverAndPersist(repo, workspaceRoot);
    EnvironmentDetector.detect(workspaceRoot, repo);
    const domainNames = Object.keys(domains);
    console.log(`\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Discovered and registered ${domainNames.length} domain(s) in SQLite SSOT:`);
    for (const name of domainNames) {
      console.log(`\x1b[36m│\x1b[0m    - \x1b[1m${name}\x1b[0m: root -> '${domains[name].root}'`);
    }
    const scanned = JSON.parse(repo.getMeta("scanned_folders") || "[]");
    const ignored = JSON.parse(repo.getMeta("ignored_folders") || "[]");
    if (scanned.length > 0) {
      console.log(`\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Mapped source directories to analyze: ${scanned.join(", ")}`);
    }
    if (ignored.length > 0) {
      console.log(`\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Excluded non-source, build, and vendor directories: ${ignored.join(", ")}`);
    }
  } finally {
    db.close();
  }
  console.log("\x1b[36m│\x1b[0m");

  // 2. Interactive AI Agent Harness Selection
  const selectedHarnesses = await promptSelectHarnesses(SUPPORTED_HARNESSES);

  // 3. Configure local project artifacts
  const forceNotice = force ? " (force regeneration of Septum-owned artifacts)" : "";
  console.log(`\x1b[36m◇\x1b[0m  Configuring project architectural rules & agent integrations${forceNotice}...`);
  ensureGitIgnore(workspaceRoot);
  const hookResult = installGitHook(workspaceRoot, force);

  const configuredFiles: string[] = [];
  const harnessErrors: Array<{ harness: string; error: string }> = [];
  for (const harnessId of selectedHarnesses) {
    const outErrs: string[] = [];
    const file = configureHarness(harnessId, workspaceRoot, force, outErrs);
    if (file) configuredFiles.push(file);
    for (const e of outErrs) {
      harnessErrors.push({ harness: harnessId, error: e });
    }
  }
  if (configuredFiles.length > 0) {
    console.log(`\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Configured agent integrations for: ${configuredFiles.join(", ")}`);
  }
  console.log("\x1b[36m│\x1b[0m");

  // 4. Run initial codebase ingestion
  console.log("\x1b[36m◇\x1b[0m  Indexing codebase AST (Tree-Sitter) to build symbol table & dependency graph...");
  try {
    await handleSyncCommand({ workspaceRoot, dbPath });
    console.log("\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m AST indexing completed successfully.");
    console.log("\x1b[36m│\x1b[0m");

    // Inspect index coverage & unindexed files from SSOT
    let unsupportedFiles: string[] = [];
    let skippedFiles: Array<{ path: string; reason: string }> = [];
    let uncoveredFiles: string[] = [];
    let enforcementMode = "warn";
    const statusDb = new SeptumDatabase(dbPath);
    try {
      const statusRepo = new SeptumRepository(statusDb.raw);
      unsupportedFiles = JSON.parse(statusRepo.getMeta("unsupported_files") || "[]");
      skippedFiles = JSON.parse(statusRepo.getMeta("skipped_files") || "[]");
      uncoveredFiles = JSON.parse(statusRepo.getMeta("uncovered_files") || "[]");
      const loadedConfig = ConfigLoader.loadFromRepository(statusRepo);
      enforcementMode = loadedConfig.settings.enforcement || "warn";
    } finally {
      statusDb.close();
    }

    const hasPartialCoverage = unsupportedFiles.length > 0 || skippedFiles.length > 0 || uncoveredFiles.length > 0;
    if (hasPartialCoverage) {
      console.log("\x1b[33m└  ⚠ Septum initialized with partial index coverage (see unindexed files below)\x1b[0m");
      if (uncoveredFiles.length > 0) {
        console.log(`   • Uncovered source files outside registered domains (${uncoveredFiles.length} file(s)): ${uncoveredFiles.slice(0, 5).join(", ")}${uncoveredFiles.length > 5 ? "..." : ""}`);
      }
      if (unsupportedFiles.length > 0) {
        console.log(`   • Unsupported parser/language (${unsupportedFiles.length} file(s)): ${unsupportedFiles.slice(0, 5).join(", ")}${unsupportedFiles.length > 5 ? "..." : ""}`);
      }
      if (skippedFiles.length > 0) {
        console.log(`   • Exceeded resource limits (${skippedFiles.length} file(s) > 2 MiB): ${skippedFiles.map((f) => f.path).slice(0, 5).join(", ")}${skippedFiles.length > 5 ? "..." : ""}`);
      }
    } else if (harnessErrors.length > 0) {
      console.log("\x1b[33m└  ⚠ Septum initialized with incomplete harness integration\x1b[0m");
      console.log("   • The SQLite database and symbol catalog are ready, but some selected harness configurations failed:");
      for (const err of harnessErrors) {
        console.log(`     - [${err.harness}] ${err.error}`);
      }
      process.exitCode = 1;
    } else {
      console.log("\x1b[32m└  ✓ Septum successfully initialized with complete index coverage!\x1b[0m");
    }

    if (hasPartialCoverage && harnessErrors.length > 0) {
      console.log("   • Warning: Selected harness configurations also encountered errors:");
      for (const err of harnessErrors) {
        console.log(`     - [${err.harness}] ${err.error}`);
      }
      process.exitCode = 1;
    }

    const isHookActive =
      (hookResult.status === "installed" || hookResult.status === "already_installed" || hookResult.status === "updated") &&
      hookResult.isActive !== false;

    if (isHookActive) {
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
    } else {
      console.log("   • Notice: Git pre-commit hook could not be set active (permission or configuration issue).");
    }

    const harnessSummaryMap: Record<string, string> = {
      antigravity: "Antigravity skills, rules, and boundary hooks active in '.gemini/'",
      claude: "Claude Code skills, boundary hooks, and MCP server active in '.claude/', '.mcp.json', and 'CLAUDE.md'",
      codex: "Codex CLI skills, boundary hooks, and MCP server active in '.codex/'",
      opencode: "Opencode skills, boundary hooks, and MCP server active in 'opencode/' and 'opencode.json'",
      agents: "Standard agent skills, boundary hooks, and MCP server active in '.agents/' and 'AGENTS.md'",
    };
    for (const hId of selectedHarnesses) {
      if (harnessSummaryMap[hId]) {
        console.log(`   • ${harnessSummaryMap[hId]}.`);
      }
    }
    console.log("   • MCP server is ready for AI coding agents via 'septum serve'.\n");
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    let failurePhase = "AST Ingestion Pipeline";
    let recoveryInstruction = "Inspect the error trace above, verify project settings, then run 'septum sync' to resume indexing.";

    if (rawMessage.includes("Cannot load Septum configuration") || rawMessage.includes("JSON") || rawMessage.includes("schema")) {
      failurePhase = "Configuration Loading";
      recoveryInstruction = "Check and repair the configuration/metadata in '.septum/septum.db', then run 'septum sync' to rebuild the symbol catalog.";
    } else if (rawMessage.includes("resource limit") || rawMessage.includes("exceeds")) {
      failurePhase = "Resource Limit";
      recoveryInstruction = "Configure ignore patterns in '.septum/septum.db' for oversized files, then run 'septum sync'.";
    } else if (rawMessage.includes("database") || rawMessage.includes("SQLite") || rawMessage.includes("locked")) {
      failurePhase = "Database Access";
      recoveryInstruction = "Ensure no other process is locking '.septum/septum.db', then run 'septum sync'.";
    } else if (rawMessage.includes("unsupported") || rawMessage.includes("degraded")) {
      failurePhase = "Parser";
      recoveryInstruction = "Review unsupported source files, then run 'septum sync'.";
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

  let dbIgnoredByGit = false;
  let dirIgnoredByGit = false;
  let gitAvailable = false;

  try {
    execFileSync("git", ["check-ignore", "-q", ".septum/septum.db"], {
      cwd,
      stdio: "ignore",
    });
    dbIgnoredByGit = true;
    gitAvailable = true;
  } catch {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd,
        stdio: "ignore",
      });
      gitAvailable = true;
    } catch {
      gitAvailable = false;
    }
  }

  if (gitAvailable) {
    try {
      execFileSync("git", ["check-ignore", "-q", ".septum/"], {
        cwd,
        stdio: "ignore",
      });
      dirIgnoredByGit = true;
    } catch {
      dirIgnoredByGit = false;
    }
  }

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    const lines = content.split(/\r?\n/).map((l) => l.trim());
    const hasNegation = lines.some((l) => l.startsWith("!") && l.includes(".septum"));

    if (gitAvailable) {
      if (dbIgnoredByGit && dirIgnoredByGit && !hasNegation) {
        console.log("  ✓ .gitignore already configured for Septum.");
        return;
      }
      const addition = `\n# Septum local database and cache\n${entriesToEnsure.join("\n")}\n`;
      fs.appendFileSync(gitignorePath, addition, "utf-8");
      console.log("  ✓ Updated .gitignore to exclude local SQLite cache (.septum/).");
      return;
    }

    const activeRules = new Set(lines.filter((l) => l.length > 0 && !l.startsWith("#")));
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

    if (missing.length > 0 || hasNegation) {
      const toAdd = missing.length > 0 ? missing : entriesToEnsure;
      const addition = `\n# Septum local database and cache\n${toAdd.join("\n")}\n`;
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
  status: "installed" | "already_installed" | "updated" | "preserved_user_hook" | "skipped_no_git" | "degraded";
  path?: string;
  message: string;
  isActive?: boolean;
}

export function resolveGitHooksDir(cwd: string): string {
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

  // Fallback if .husky exists in mock/non-git fixture
  const huskyCandidate = path.join(cwd, ".husky");
  if (fs.existsSync(huskyCandidate)) {
    return huskyCandidate;
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

export function installGitHook(cwd: string, force: boolean = false): GitHookInstallResult {
  const gitDir = path.join(cwd, ".git");
  if (!fs.existsSync(gitDir)) {
    console.log("  ⚠ No .git directory found. Skipping pre-commit hook installation.");
    return {
      status: "skipped_no_git",
      message: "No .git directory found. Skipping pre-commit hook installation.",
      isActive: false,
    };
  }

  const hooksDir = resolveGitHooksDir(cwd);
  const huskyDir = path.join(cwd, ".husky");
  const isHuskyActive =
    fs.existsSync(huskyDir) &&
    (path.resolve(hooksDir) === path.resolve(huskyDir) || hooksDir.startsWith(huskyDir));

  const ensureExecutable = (filePath: string): boolean => {
    try {
      const stat = fs.statSync(filePath);
      if ((stat.mode & 0o111) === 0) {
        fs.chmodSync(filePath, 0o755);
      }
      return (fs.statSync(filePath).mode & 0o111) !== 0;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  Notice: Could not set executable permission on '${filePath}': ${message}`);
      return false;
    }
  };

  if (isHuskyActive) {
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
        const legacySeptumLineRegex = /^.*septum\s+check.*$/m;
        let updated = existing;
        if (septumBlockRegex.test(existing)) {
          updated = existing.replace(septumBlockRegex, hookCommand);
        } else if (legacySeptumLineRegex.test(existing)) {
          updated = existing.replace(legacySeptumLineRegex, hookCommand);
        }
        if (updated !== existing) {
          fs.writeFileSync(huskyPreCommit, updated, "utf-8");
          huskyStatus = "updated";
        } else {
          huskyStatus = "already_installed";
        }
      } else {
        huskyStatus = "already_installed";
      }
    } else {
      fs.writeFileSync(huskyPreCommit, `#!/usr/bin/env sh\n${hookCommand}\n`, "utf-8");
    }

    const execOk = ensureExecutable(huskyPreCommit);
    console.log("  ✓ Installed pre-commit hook in .husky/pre-commit.");
    return {
      status: huskyStatus,
      path: huskyPreCommit,
      message: "Configured pre-commit hook in .husky/pre-commit.",
      isActive: execOk,
    };
  }

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
    const hasSeptumCommand =
      existingContent.includes("septum check --staged") ||
      existingContent.includes("bun run ./bin/septum.ts check --staged");
    const hasSeptumMarker =
      existingContent.includes("Septum deterministic boundary pre-commit hook");

    if (!hasSeptumCommand && !hasSeptumMarker) {
      console.warn(`  ⚠ Existing non-Septum pre-commit hook detected at '${displayPath}'. Preserving existing hook.`);
      return {
        status: "preserved_user_hook",
        path: preCommitHook,
        message: `Existing non-Septum pre-commit hook detected at '${displayPath}'. Preserving existing hook.`,
        isActive: false,
      };
    }

    // Determine if file is a mixed user hook or pure Septum-owned hook
    const septumBlockRegex = /# Septum deterministic boundary pre-commit hook[\s\S]*?\nfi/m;
    const contentWithoutSeptum = existingContent
      .replace(septumBlockRegex, "")
      .replace(/^#!.*$/m, "")
      .replace(/echo\s+["'][^"']*Septum[^"']*["']/g, "")
      .replace(/^[ \t]*septum\s+check\s+--staged[^\r\n]*/gm, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    // Check whether outside lines look like user workflow commands
    const isCustomizedSeptumOnly =
      hasSeptumMarker &&
      contentWithoutSeptum.every((line) => line.includes("CUSTOM_SEPTUM") || line.includes("echo"));

    const isMixedUserHook = contentWithoutSeptum.length > 0 && !isCustomizedSeptumOnly;

    if (isMixedUserHook) {
      if (!force) {
        // Mixed user hook: preserve all user commands without modification
        const execOk = ensureExecutable(preCommitHook);
        console.log(`  ✓ Septum pre-commit hook is active in mixed user hook at '${displayPath}'.`);
        return {
          status: "already_installed",
          path: preCommitHook,
          message: `Septum pre-commit hook is already installed in mixed hook at '${displayPath}'.`,
          isActive: execOk,
        };
      } else {
        // Force: replace only the Septum block/command, preserving user commands
        let updated = existingContent;
        if (septumBlockRegex.test(existingContent)) {
          updated = existingContent.replace(septumBlockRegex, hookScript.replace(/^#![^\n]+\n/, "").trim());
        } else {
          updated = existingContent.replace(/^.*septum\s+check\s+--staged.*$/m, hookScript.replace(/^#![^\n]+\n/, "").trim());
        }
        fs.writeFileSync(preCommitHook, updated, "utf-8");
        const execOk = ensureExecutable(preCommitHook);
        console.log(`  ✓ Force-regenerated Septum block in mixed pre-commit hook at '${displayPath}' (--force).`);
        return {
          status: "updated",
          path: preCommitHook,
          message: `Force-regenerated Septum block in mixed pre-commit hook at '${displayPath}'.`,
          isActive: execOk,
        };
      }
    }

    if (existingContent.trim() === hookScript.trim() && !force) {
      const execOk = ensureExecutable(preCommitHook);
      console.log(`  ✓ Septum pre-commit hook is already installed at '${displayPath}'.`);
      return {
        status: "already_installed",
        path: preCommitHook,
        message: `Septum pre-commit hook is already installed at '${displayPath}'.`,
        isActive: execOk,
      };
    }

    fs.writeFileSync(preCommitHook, hookScript, "utf-8");
    const execOk = ensureExecutable(preCommitHook);
    const actionDesc = force ? "Force-regenerated" : "Updated";
    console.log(`  ✓ ${actionDesc} Septum pre-commit hook at '${displayPath}'${force ? " (--force)" : ""}.`);
    return {
      status: "updated",
      path: preCommitHook,
      message: `${actionDesc} Septum pre-commit hook at '${displayPath}'.`,
      isActive: execOk,
    };
  }

  fs.writeFileSync(preCommitHook, hookScript, "utf-8");
  const execOk = ensureExecutable(preCommitHook);
  console.log(`  ✓ Installed executable git pre-commit hook at '${displayPath}'.`);
  return {
    status: "installed",
    path: preCommitHook,
    message: `Installed executable git pre-commit hook at '${displayPath}'.`,
    isActive: execOk,
  };
}
