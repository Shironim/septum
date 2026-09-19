import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { DatabaseRepository } from "../../core/database/repository.ts";
import type { SymbolKind } from "../../types/index.ts";

export interface GetSymbolHotspotsArgs {
  min_lines?: number;
  kind?: SymbolKind;
  domain?: string;
  limit?: number;
}

export function handleGetSymbolHotspots(
  repo: DatabaseRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolHotspotsArgs
) {
  const minLines = args.min_lines ?? 30;
  const limit = args.limit ?? 30;

  const hotspots = repo.getHotspotSymbols({
    minLines,
    kind: args.kind,
    domain: args.domain,
    limit,
  });

  const payload = {
    total_found: hotspots.length,
    threshold_min_lines: minLines,
    hotspots: hotspots.map((h) => ({
      name: h.name,
      kind: h.kind,
      line_count: h.line_count,
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
