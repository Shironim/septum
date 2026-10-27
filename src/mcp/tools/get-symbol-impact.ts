import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { GetSymbolImpactArgs } from "../../types/index.ts";

export function handleGetSymbolImpact(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolImpactArgs,
  workspaceRoot?: string
) {
  const symbol = (args.symbol_ref?.name || args.symbol || (args as unknown as Record<string, unknown>).query || "").toString().trim();
  if (!symbol) {
    throw new Error(
      "Missing required argument: 'symbol' (e.g. 'OrderService::cancelOrder', 'OrderService', or 'cancelOrder')"
    );
  }

  if (args.symbol_ref) {
    const file = repo.getFileByPath(args.symbol_ref.file_path);
    if (!file || file.content_hash !== args.symbol_ref.indexed_content_hash) {
      return { content: [{ type: "text" as const, text: JSON.stringify({
        target_symbol: symbol, status: "stale_reference", found_in_index: false,
        message: "Declaration reference is stale; locate the symbol again.",
      }) }] };
    }
  }

  const candidates = repo.findSymbolsByName(symbol, {
    domain: args.domain,
    filePath: args.file_path,
    reference: args.symbol_ref,
  });
  if (candidates.length > 1) {
    return { content: [{ type: "text" as const, text: JSON.stringify({
      status: "ambiguous", target_symbol: symbol, found_in_index: false,
      candidates: candidates.map(candidate => ({ name: candidate.name, file_path: candidate.file_path, symbol_ref: candidate.symbol_ref })),
      message: "Multiple declarations match; select a candidate with symbol_ref or narrow with file_path.",
    }, null, 2) }] };
  }
  const selectedCandidate = candidates[0];
  const impact = repo.getSymbolImpact(symbol, {
    domain: args.domain,
    filePath: args.file_path || selectedCandidate?.file_path,
    reference: args.symbol_ref || selectedCandidate?.symbol_ref,
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
