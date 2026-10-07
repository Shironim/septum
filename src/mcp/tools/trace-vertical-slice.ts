import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { VerticalSliceTracer } from "../../core/resolver/vertical-slice-tracer.ts";
import type { VerticalSliceTraceResponse } from "../../types/index.ts";

export interface TraceVerticalSliceArgs {
  query: string;
}

export function handleTraceVerticalSlice(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: TraceVerticalSliceArgs
) {
  if (!args.query) {
    throw new Error(
      "Missing required argument: 'query' (e.g. 'POST /orders/{id}/status', 'OrderController@updateStatus', or task intent 'Ubah status order di dashboard')"
    );
  }

  const workspaceRoot = (config.settings as Record<string, unknown>)?.workspace_root as string || process.cwd();
  const tracer = new VerticalSliceTracer(repo, workspaceRoot);
  const result: VerticalSliceTraceResponse = tracer.trace(args.query);
  if (result.chain && !result.slice) {
    result.slice = result.chain;
  }

  let formattedText = result.message;

  if (result.found && result.alternatives && result.alternatives.length > 0) {
    formattedText += `\n\n• Other Matching Slices:\n`;
    for (const alt of result.alternatives) {
      formattedText += `    - ${alt.method} ${alt.uri} -> ${alt.controller}@${alt.action}\n`;
    }
  } else if (!result.found && result.alternatives && result.alternatives.length > 0) {
    formattedText += `\n\nAvailable Slices:\n`;
    for (const alt of result.alternatives) {
      formattedText += `    - ${alt.method} ${alt.uri} -> ${alt.controller}@${alt.action}\n`;
    }
  }

  if (!formattedText || !formattedText.trim()) {
    formattedText = `[Septum Status: Unindexed/Not Found]\nNo vertical slice or matching route/controller found for query '${args.query}'.\nIf this project/domain is not yet registered in Septum, run 'septum_register_domain' to initialize the domain catalog, or verify domain boundaries in .septum.`;
  }

  return {
    content: [
      {
        type: "text",
        text: formattedText.trim(),
      },
    ],
    metadata: result,
  };
}
