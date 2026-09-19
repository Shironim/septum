import type { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";

export interface CheckBoundaryArgs {
  file_path?: string;
  file_paths?: string[];
  proposed_imports?: string[];
  feature_key?: string;
}

export function handleCheckBoundary(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  args: CheckBoundaryArgs
) {
  const filesToCheck: string[] = [];
  if (args.file_paths && Array.isArray(args.file_paths) && args.file_paths.length > 0) {
    filesToCheck.push(...args.file_paths);
  } else if (args.file_path) {
    filesToCheck.push(args.file_path);
  } else {
    throw new Error("Missing required argument: specify either 'file_path' or 'file_paths'");
  }

  // Multi-file batch evaluation
  if (filesToCheck.length > 1) {
    const results = filesToCheck.map((filePath) => {
      const violations = evaluator.evaluate(filePath, args.proposed_imports ?? [], args.feature_key, config);
      return {
        file: filePath,
        status: violations.length > 0 ? "rejected" : "approved",
        violations,
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
  const violations = evaluator.evaluate(singleFile, args.proposed_imports ?? [], args.feature_key, config);

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
              message: "Boundary violation detected. Proposed imports violate bounded context architecture.",
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
            message: "No boundary violations detected. Proposed imports are permissible.",
          },
          null,
          2
        ),
      },
    ],
  };
}
