import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { GetSymbolImpactArgs } from "../../types/index.ts";

export function handleGetSymbolImpact(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolImpactArgs,
  workspaceRoot?: string
) {
  const symbol = (args.symbol || (args as unknown as Record<string, unknown>).query || "").toString().trim();
  if (!symbol) {
    throw new Error(
      "Missing required argument: 'symbol' (e.g. 'OrderService::cancelOrder', 'OrderService', or 'cancelOrder')"
    );
  }

  const candidates = repo.findSymbolsByName(symbol, { domain: args.domain });
  if (candidates.length > 1) {
    return { content: [{ type: "text" as const, text: JSON.stringify({
      status: "ambiguous", target_symbol: symbol, found_in_index: false,
      candidates: candidates.map(candidate => ({ name: candidate.name, symbol_ref: candidate.symbol_ref })),
      message: "Multiple declarations match; impact cannot establish a complete caller count.",
    }) }] };
  }
  const impact = repo.getSymbolImpact(symbol, {
    domain: args.domain,
    workspaceRoot: workspaceRoot || args.workspace_path,
  });

  const relationships = repo.getImportRelationships(workspaceRoot || args.workspace_path);
  const targetFiles = candidates.map(candidate => candidate.file_path);
  const importDependents = relationships.filter(edge => edge.resolution.status === "resolved" && edge.resolution.targets.some(target => target.files.some(file => targetFiles.includes(file))));
  const payload = { ...impact, coverage: "partial", inbound_callers_complete: false,
    relationship_limits: "Legacy inbound caller hints are inferred; import dependencies are reported separately and do not prove executed calls.",
    import_dependents: importDependents,
    resolution_warnings: relationships.filter(edge => !["resolved","external"].includes(edge.resolution.status) || edge.resolution.coverage === "conditional"),
  };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
