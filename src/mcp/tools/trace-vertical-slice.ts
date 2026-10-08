import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { VerticalSliceTracer } from "../../core/resolver/vertical-slice-tracer.ts";
import type { VerticalSliceTraceResponse } from "../../types/index.ts";

export interface TraceVerticalSliceArgs {
  query?: string;
  symbol?: string;
  route?: string;
  max_depth?: number;
}

export function handleTraceVerticalSlice(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: TraceVerticalSliceArgs,
  workspaceRoot?: string
) {
  const query = (
    args.query ||
    args.symbol ||
    args.route ||
    ""
  ).toString().trim();

  if (!query) {
    throw new Error(
      "Missing required argument: 'query' (e.g. 'POST /orders/{id}/status', 'OrderController@updateStatus', or task intent 'Ubah status order di dashboard')"
    );
  }

  const root =
    workspaceRoot ||
    ((config.settings as Record<string, unknown>)?.workspace_root as string) ||
    process.cwd();
  const tracer = new VerticalSliceTracer(repo, root);
  const result: VerticalSliceTraceResponse = tracer.trace(query);
  const chain = result.chain || result.slice || [];

  let summary = "";
  if (result.found && chain.length > 0) {
    summary = chain
      .map((node) => `[${(node.stage || "STAGE").toUpperCase()}] ${node.symbol}`)
      .join(" ➔ ");
  } else if (result.found && result.entrypoint) {
    summary = `[ENTRYPOINT] ${result.entrypoint.method} ${result.entrypoint.uri} ➔ ${result.entrypoint.controller}@${result.entrypoint.action}`;
  } else {
    summary = `[NOT FOUND] No vertical slice matching '${query}'`;
  }

  const payload = {
    status: result.found ? "success" : "not_found",
    query,
    found: result.found,
    confidence: result.confidence || (result.found ? "exact" : undefined),
    is_exact_match: result.is_exact_match,
    architecture_style: result.architecture_style,
    entrypoint: result.entrypoint || null,
    chain,
    alternatives: result.alternatives || [],
    summary,
    message: result.message || summary,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    metadata: payload,
  };
}
