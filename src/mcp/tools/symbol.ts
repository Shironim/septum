import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { IngestionPipeline } from "../../core/ingestion/pipeline.ts";
import type { SymbolToolArgs } from "../schemas.ts";
import { handleLocateSymbol } from "./locate-symbol.ts";
import { handleGetSymbol } from "./get-symbol.ts";
import { handleGetSymbolImpact } from "./get-symbol-impact.ts";
import { handleGetSymbolHotspots } from "./get-symbol-hotspots.ts";

export type { SymbolToolArgs };

export async function handleSymbolTool(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: SymbolToolArgs,
  pipeline?: IngestionPipeline,
  workspaceRoot?: string
) {
  const action = args.action || "locate";

  switch (action) {
    case "inspect": {
      const symbol = args.symbol || args.query || "";
      return handleGetSymbol(
        repo,
        config,
        {
          symbol,
          query: symbol,
          domain: args.domain,
          include_dependencies: args.include_dependencies,
        },
        workspaceRoot
      );
    }

    case "impact": {
      const symbol = args.symbol || args.query || "";
      return handleGetSymbolImpact(
        repo,
        config,
        {
          symbol,
          query: symbol,
        },
        workspaceRoot
      );
    }

    case "hotspots":
      return handleGetSymbolHotspots(
        repo,
        config,
        {
          min_lines: args.min_lines,
          min_nesting: args.min_nesting,
          kind: args.kind,
          domain: args.domain,
          limit: args.limit ?? 30,
          sort_by: (args.sort_by === "line_count" ? "lines" : args.sort_by) as any,
          workspace_path: args.workspace_path,
        },
        workspaceRoot
      );

    case "locate":
    default:
      return await handleLocateSymbol(
        repo,
        config,
        {
          query: args.query || args.symbol || "",
          domain: args.domain,
          limit: args.limit ?? 10,
          workspace_path: args.workspace_path,
        },
        pipeline,
        workspaceRoot
      );
  }
}
