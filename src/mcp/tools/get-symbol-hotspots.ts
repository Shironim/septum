import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { SymbolKind } from "../../types/index.ts";
import type { GetSymbolHotspotsArgs } from "../schemas.ts";

export type { GetSymbolHotspotsArgs } from "../schemas.ts";

export function handleGetSymbolHotspots(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolHotspotsArgs,
  _workspaceRoot?: string
) {
  const minLines = args.min_lines ?? (args.min_nesting ? 0 : 30);
  const minNesting = args.min_nesting ?? 1;
  const limit = args.limit ?? 30;
  const sortBy = args.sort_by ?? "risk_score";

  const hotspots = repo.getHotspotSymbols({
    minLines,
    minNesting,
    kind: args.kind as SymbolKind | undefined,
    domain: args.domain,
    limit,
    sortBy,
  });

  const payload = {
    total_found: hotspots.length,
    threshold_min_lines: minLines,
    threshold_min_nesting: minNesting,
    sort_by: sortBy,
    hotspots: hotspots.map((h) => ({
      name: h.name,
      kind: h.kind,
      line_count: h.line_count,
      nesting_depth: (h as any).nesting_depth ?? 1,
      risk_score: (h as any).risk_score ?? h.line_count,
      line_span: `${h.line_start}-${h.line_end}`,
      file_path: h.file_path,
      domain: h.domain_name,
      signature: h.signature,
    })),
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
