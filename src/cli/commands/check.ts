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
  if (options.strict) config.settings.enforcement = "strict";
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo);

  try {
    let violations: BoundaryViolation[] = [];

    if (options.staged) {
      violations = (await auditStagedFiles(evaluator, config, process.cwd(), options.feature, repo)).violations;
    } else {
      await new IngestionPipeline(repo).run(config, { verifyContent: true });
      const unsupported = JSON.parse(repo.getMeta("unsupported_files") || "[]") as string[];
      if (unsupported.length > 0) {
        throw new Error(`Cannot complete boundary audit: unsupported source files: ${unsupported.join(", ")}`);
      }
      const skipped = JSON.parse(repo.getMeta("skipped_files") || "[]") as {path: string}[];
      if (skipped.length) throw new Error(`Cannot complete boundary audit: files exceed resource limits: ${skipped.map(file => file.path).join(", ")}`);
      violations = evaluator.auditCodebase(config);
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
