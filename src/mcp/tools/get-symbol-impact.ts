import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { GetSymbolImpactArgs } from "../../types/index.ts";

export function handleGetSymbolImpact(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolImpactArgs
) {
  if (!args.symbol) {
    throw new Error(
      "Missing required argument: 'symbol' (e.g. 'OrderService::cancelOrder', 'OrderService', or 'cancelOrder')"
    );
  }

  const impact = repo.getSymbolImpact(args.symbol);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(impact, null, 2),
      },
    ],
  };
}
