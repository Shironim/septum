import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { GetSymbolImpactArgs } from "../../types/index.ts";

export function handleGetSymbolImpact(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolImpactArgs,
  _workspaceRoot?: string
) {
  const symbol = (args.symbol || (args as unknown as Record<string, unknown>).query || "").toString().trim();
  if (!symbol) {
    throw new Error(
      "Missing required argument: 'symbol' (e.g. 'OrderService::cancelOrder', 'OrderService', or 'cancelOrder')"
    );
  }

  const impact = repo.getSymbolImpact(symbol);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(impact, null, 2),
      },
    ],
  };
}
