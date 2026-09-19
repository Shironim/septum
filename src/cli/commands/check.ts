import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { ASTParserEngine } from "../../core/parser/tree-sitter.ts";
import type { BoundaryViolation } from "../../types/index.ts";

export interface CheckCommandOptions {
  strict?: boolean;
  staged?: boolean;
  feature?: string;
}

export async function handleCheckCommand(
  optionsOrStrict?: boolean | CheckCommandOptions
): Promise<void> {
  const options: CheckCommandOptions =
    typeof optionsOrStrict === "boolean" ? { strict: optionsOrStrict } : optionsOrStrict || {};

  console.log(
    options.staged
      ? "[Septum] Auditing git staged files against domain boundaries..."
      : "[Septum] Running codebase boundary integrity check..."
  );

  const config = ConfigLoader.load();
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo);

  let violations: BoundaryViolation[] = [];

  if (options.staged) {
    violations = await auditStagedFiles(evaluator, config, options.feature);
  } else {
    violations = evaluator.auditCodebase(config);
  }

  if (violations.length === 0) {
    console.log("✓ All domain boundaries are clean. Zero cross-domain leaks detected.");
    db.close();
    return;
  }

  console.error(`\n[Septum Boundary Violation] Found ${violations.length} boundary violation(s):\n`);

  for (const v of violations) {
    console.error(`  ✕ [${v.rule.toUpperCase()}] at ${v.file}:${v.line}`);
    console.error(`    Source Domain:  ${v.source_domain}`);
    console.error(`    Target Domain:  ${v.target_domain}`);
    console.error(`    Import Target:  ${v.imported_target}`);
    console.error(`    Message:        ${v.message}\n`);
  }

  db.close();

  const isStrict = options.strict || config.settings.enforcement === "strict";
  if (isStrict) {
    console.error("[Septum Failure] Process terminated with exit code 1 due to boundary violations.");
    process.exit(1);
  }
}

async function auditStagedFiles(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  featureKey?: string
): Promise<BoundaryViolation[]> {
  const violations: BoundaryViolation[] = [];
  let stagedFiles: string[] = [];

  try {
    const gitOutput = execSync("git diff --cached --name-only --diff-filter=ACM", {
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
    stagedFiles = gitOutput
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Septum Warning] Could not retrieve git staged files: ${msg}`);
    return violations;
  }

  if (stagedFiles.length === 0) {
    console.log("  Notice: No staged files found in git repository.");
    return violations;
  }

  const astEngine = new ASTParserEngine();

  for (const relPath of stagedFiles) {
    const fullPath = path.resolve(process.cwd(), relPath);
    if (!fs.existsSync(fullPath)) continue;

    // 1. Feature touchpoint check if featureKey provided
    if (featureKey) {
      const tpViolations = evaluator.checkFeatureTouchpoints(featureKey, relPath, config);
      violations.push(...tpViolations);
    }

    const sourceDomain = evaluator.resolveSourceDomain(relPath, config);
    if (!sourceDomain) continue;

    const sourceConfig = config.domains[sourceDomain];
    if (!sourceConfig) continue;

    const forbidden = sourceConfig.forbidden_dependencies ?? [];
    const allowed = sourceConfig.allowed_dependencies ?? [];

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const parsed = await astEngine.parseFile(fullPath, content);

      for (const dep of parsed.dependencies) {
        if (dep.is_external) continue;

        const targetDomain = evaluator.resolveTargetDomain(
          dep.target,
          config,
          relPath
        );

        if (!targetDomain || targetDomain === sourceDomain) continue;

        if (forbidden.includes(targetDomain)) {
          violations.push({
            file: relPath,
            line: dep.line_number,
            source_domain: sourceDomain,
            target_domain: targetDomain,
            imported_target: dep.target,
            rule: "forbidden_dependency",
            message: `Illegal import: Domain '${sourceDomain}' is strictly prohibited from importing domain '${targetDomain}'.`,
          });
        } else if (config.settings.enforcement === "strict" && !allowed.includes(targetDomain)) {
          violations.push({
            file: relPath,
            line: dep.line_number,
            source_domain: sourceDomain,
            target_domain: targetDomain,
            imported_target: dep.target,
            rule: "disallowed_dependency",
            message: `Disallowed dependency: '${targetDomain}' is not declared in allowed_dependencies for domain '${sourceDomain}'.`,
          });
        }
      }
    } catch {
      // Ignore unparseable files
    }
  }

  return violations;
}
