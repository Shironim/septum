import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { VerticalSliceTracer } from "../../core/resolver/vertical-slice-tracer.ts";
import type { VerticalSliceTraceResponse } from "../../types/index.ts";
import type { TraceVerticalSliceArgs } from "../schemas.ts";

export type { TraceVerticalSliceArgs } from "../schemas.ts";

export function handleTraceVerticalSlice(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: Partial<TraceVerticalSliceArgs> & { route?: string },
  workspaceRoot?: string,
  signal?: AbortSignal
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
    args.workspace_path ||
    ((config.settings as Record<string, unknown>)?.workspace_root as string) ||
    process.cwd();
  const maxDepth = Math.min(Math.max(Math.trunc(Number(args.max_depth ?? 5)), 1), 8);
  const tracer = new VerticalSliceTracer(repo, root, config.settings.ignore_patterns, false);
  return tracer.traceAsync(query, maxDepth, signal).then((result: VerticalSliceTraceResponse) => {
  const chain = result.chain || result.slice || [];

  let summary = "";
  if (result.found && chain.length > 0) {
    summary = chain
      .map((node) => `[${(node.stage || "STAGE").toUpperCase()}] ${node.symbol}`)
      .join(" ➔ ");
  } else if (result.found && result.entrypoint) {
    summary = `[ENTRYPOINT] ${result.entrypoint.method} ${result.entrypoint.uri} ➔ ${result.entrypoint.controller}@${result.entrypoint.action}`;
  } else if (result.diagnostics?.length || result.coverage === "partial") {
    summary = ` [UNKNOWN] ${result.message || `No matching slice in the available static catalog for '${query}'.`}`.trim();
  } else {
    summary = `[NOT FOUND] No matching slice in the available static catalog for '${query}'; this does not prove the route is absent at runtime.`;
  }

  const payload = {
    status: result.diagnostics?.length ? "unknown" : result.found ? "success" : "not_found",
    coverage: result.coverage,
    diagnostics: result.diagnostics,
    query,
    found: result.found,
    confidence: result.confidence || (result.found ? "exact" : undefined),
    is_exact_match: result.is_exact_match,
    architecture_style: result.architecture_style,
    max_depth_applied: result.max_depth_applied ?? maxDepth,
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
  });
}

