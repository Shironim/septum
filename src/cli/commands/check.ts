import { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import type { BoundaryViolation } from "../../types/index.ts";
import { IngestionPipeline } from "../../core/ingestion/pipeline.ts";
import { auditStagedFiles } from "../../core/boundary/staged-auditor.ts";

export interface CheckCommandOptions {
  strict?: boolean;
  staged?: boolean;
  feature?: string;
  json?: boolean;
}

export async function handleCheckCommand(
  optionsOrStrict?: boolean | CheckCommandOptions
): Promise<void> {
  const options: CheckCommandOptions =
    typeof optionsOrStrict === "boolean" ? { strict: optionsOrStrict } : optionsOrStrict || {};

  if (!options.json) {
    console.log(
      options.staged
        ? "[Septum] Auditing git staged files against domain boundaries..."
        : "[Septum] Running codebase boundary integrity check..."
    );
  }

  const config = ConfigLoader.load();
  if (options.strict) config.settings.enforcement = "strict";
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo);

  try {
    let violations: BoundaryViolation[] = [];

    const totalDomains = Object.keys(config.domains).length;
    if (!options.staged && totalDomains === 0) {
      const isStrict = options.strict || config.settings.enforcement === "strict";
      if (options.json) {
        console.log(JSON.stringify({
          status: "not_indexed",
          strict: isStrict,
          violations: [],
          message: "No domains registered in workspace. Run 'septum init' first to discover and register domains.",
        }, null, 2));
      } else {
        console.warn("[Septum Warning] No domains registered in workspace. Run 'septum init' first to discover and register domains.");
      }
      if (isStrict) process.exitCode = 1;
      return;
    }

    if (options.staged) {
      const staged = await auditStagedFiles(evaluator, config, process.cwd(), options.feature, repo);
      violations = staged.violations;
      if (staged.resolution_issues.length && violations.length === 0) {
        console.warn(options.json ? JSON.stringify({ status: "unknown", resolution_issues: staged.resolution_issues }) : "Staged import resolution is incomplete; approval is unknown.");
        if (options.strict || config.settings.enforcement === "strict") process.exitCode = 1;
        return;
      }
    } else {
      await new IngestionPipeline(repo).run(config, { verifyContent: true });
      const unsupported = JSON.parse(repo.getMeta("unsupported_files") || "[]") as string[];
      if (unsupported.length > 0) {
        throw new Error(`Cannot complete boundary audit: unsupported source files: ${unsupported.join(", ")}`);
      }
      const skipped = JSON.parse(repo.getMeta("skipped_files") || "[]") as {path: string}[];
      if (skipped.length) throw new Error(`Cannot complete boundary audit: files exceed resource limits: ${skipped.map(file => file.path).join(", ")}`);
      violations = evaluator.auditCodebase(config);
      const incomplete = repo.getImportRelationships(process.cwd()).filter(edge => edge.freshness !== "current" || edge.index_coverage !== "complete" || !["resolved","external"].includes(edge.resolution.status) || edge.resolution.coverage === "conditional");
      if (incomplete.length && violations.length === 0) {
        const strict = options.strict || config.settings.enforcement === "strict";
        const payload = { status: "unknown", relationships: incomplete, message: "Import resolution is incomplete; boundary approval is unknown." };
        console.warn(options.json ? JSON.stringify(payload) : payload.message);
        if (strict) process.exitCode = 1;
        return;
      }
    }

    if (options.json) {
      const isStrict = options.strict || config.settings.enforcement === "strict";
      console.log(JSON.stringify({
        status: violations.length === 0 ? "clean" : "violations_found",
        strict: isStrict,
        violations,
      }, null, 2));
      if (violations.length > 0 && isStrict) process.exitCode = 1;
      return;
    }

    if (violations.length === 0) {
      console.log("✓ All domain boundaries are clean. Zero cross-domain leaks detected.");
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


    const isStrict = options.strict || config.settings.enforcement === "strict";
    if (isStrict) {
      console.error("[Septum Failure] Process terminated with exit code 1 due to boundary violations.");
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}
