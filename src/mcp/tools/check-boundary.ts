import type { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";

export interface CheckBoundaryArgs {
  file_path?: string;
  filePath?: string;
  file?: string;
  path?: string;
  from_file?: string;
  fromFile?: string;
  to_file?: string | string[];
  toFile?: string | string[];
  file_paths?: string[];
  filePaths?: string[];
  files?: string[];
  paths?: string[];
  proposed_imports?: string[];
  proposedImports?: string[];
  imports?: string[];
  feature_key?: string;
  featureKey?: string;
  feature?: string;
}

export function handleCheckBoundary(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  args: CheckBoundaryArgs,
  repo?: SeptumRepository,
  _workspaceRoot?: string
) {
  const rawToFile = args.to_file ?? args.toFile;
  const toFileImports = rawToFile ? (Array.isArray(rawToFile) ? rawToFile.map(String) : [String(rawToFile)]) : [];
  const rawFilePaths = args.file_paths ?? args.filePaths ?? args.files ?? args.paths;
  const rawFilePath = args.file_path ?? args.filePath ?? args.file ?? args.path ?? args.from_file ?? args.fromFile;
  const proposedImports = [
    ...(args.proposed_imports ?? args.proposedImports ?? args.imports ?? []),
    ...toFileImports,
  ];
  const featureKey = args.feature_key ?? args.featureKey ?? args.feature;

  const filesToCheck: string[] = [];
  if (rawFilePaths && Array.isArray(rawFilePaths) && rawFilePaths.length > 0) {
    filesToCheck.push(...rawFilePaths);
  } else if (rawFilePath) {
    if (Array.isArray(rawFilePath)) {
      filesToCheck.push(...rawFilePath);
    } else {
      filesToCheck.push(rawFilePath);
    }
  } else {
    throw new Error("Missing required argument: specify either 'file_path' or 'file_paths'");
  }

  // Multi-file batch evaluation
  if (filesToCheck.length > 1) {
    const results = filesToCheck.map((filePath) => {
      const violations = evaluator.evaluate(filePath, proposedImports, featureKey, config);
      const impact = repo?.getFileInboundImpact(filePath);
      return {
        file: filePath,
        status: violations.length > 0 ? "rejected" : "approved",
        violations,
        impact_summary: impact
          ? {
              direct_dependents: impact.direct_dependents_count,
              top_consumers: impact.top_consumers,
              symbols_count: impact.symbols_count,
              risk_level: impact.risk_level,
            }
          : undefined,
      };
    });

    const totalViolations = results.reduce((acc, r) => acc + r.violations.length, 0);
    const hasViolations = totalViolations > 0;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: hasViolations ? "rejected" : "approved",
              total_checked: filesToCheck.length,
              total_violations: totalViolations,
              results,
              message: hasViolations
                ? `${totalViolations} boundary violation(s) detected across ${filesToCheck.length} file(s).`
                : Object.keys(config?.domains || {}).length === 0
                ? `All ${filesToCheck.length} file(s) approved. [Septum Notice: Domain catalog is currently unindexed. Run 'septum_register_domain' to initialize bounded contexts.]`
                : `All ${filesToCheck.length} file(s) approved. No boundary violations detected.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Single file evaluation (backward-compatible output)
  const singleFile = filesToCheck[0];
  const violations = evaluator.evaluate(singleFile, proposedImports, featureKey, config);
  const impact = repo?.getFileInboundImpact(singleFile);

  if (violations.length > 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "rejected",
              file: singleFile,
              violations_count: violations.length,
              violations,
              impact_summary: impact
                ? {
                    direct_dependents: impact.direct_dependents_count,
                    top_consumers: impact.top_consumers,
                    symbols_count: impact.symbols_count,
                    risk_level: impact.risk_level,
                  }
                : undefined,
              message:
                Object.keys(config?.domains || {}).length === 0
                  ? "Boundary integrity check failed: Domain catalog is currently unindexed. Run 'septum_register_domain' to initialize bounded contexts."
                  : violations.some((v) => v.rule === "unmapped_domain")
                  ? "Boundary integrity check failed: File does not belong to any declared bounded context."
                  : "Boundary violation detected. Proposed imports violate bounded context architecture.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "approved",
            file: singleFile,
            impact_summary: impact
              ? {
                  direct_dependents: impact.direct_dependents_count,
                  top_consumers: impact.top_consumers,
                  symbols_count: impact.symbols_count,
                  risk_level: impact.risk_level,
                }
              : undefined,
            message:
              Object.keys(config?.domains || {}).length === 0
                ? "No boundary violations detected. [Septum Notice: Domain catalog is currently unindexed. Run 'septum_register_domain' to initialize bounded contexts.]"
                : impact && impact.direct_dependents_count > 0
                ? `No boundary violations detected. Caution: ${impact.direct_dependents_count} dependent file(s) consume this file.`
                : "No boundary violations detected. Proposed imports are permissible.",
          },
          null,
          2
        ),
      },
    ],
  };
}
