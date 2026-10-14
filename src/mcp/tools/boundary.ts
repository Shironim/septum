import type { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { BoundaryToolArgs } from "../schemas.ts";
import { handleCheckBoundary } from "./check-boundary.ts";

export type { BoundaryToolArgs };

export async function handleBoundaryTool(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  args: BoundaryToolArgs,
  repo?: SeptumRepository,
  workspaceRoot?: string
) {
  return await handleCheckBoundary(evaluator, config, args as any, repo, workspaceRoot);
}
