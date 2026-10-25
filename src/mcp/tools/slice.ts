import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { SliceToolArgs } from "../schemas.ts";
import { handleTraceVerticalSlice } from "./trace-vertical-slice.ts";

export type { SliceToolArgs };

export function handleSliceTool(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: SliceToolArgs,
  workspaceRoot?: string,
  signal?: AbortSignal
) {
  return handleTraceVerticalSlice(repo, config, args, workspaceRoot, signal);
}
