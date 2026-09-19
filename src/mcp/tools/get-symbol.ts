import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { SymbolLocator } from "../../core/resolver/symbol-locator.ts";
import type { GetSymbolArgs } from "../../types/index.ts";

export function handleGetSymbol(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolArgs
) {
  if (!args.symbol) {
    throw new Error(
      "Missing required argument: 'symbol' (e.g. 'OrderController::cancelOrder', 'OrderService', or 'cancelOrder')"
    );
  }

  const details = repo.getSymbolDetails(args.symbol, {
    domain: args.domain,
    includeDependencies: args.include_dependencies,
  });

  if (details) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(details, null, 2),
        },
      ],
    };
  }

  // Fallback to fuzzy SymbolLocator to provide actionable hints
  const locator = new SymbolLocator(repo);
  const fallback = locator.locate(args.symbol, args.domain);

  const payload = {
    symbol: args.symbol,
    found: false,
    message: `Symbol '${args.symbol}' was not found in the deterministic catalog.`,
    suggestions: fallback.suggestions.map((s) => ({
      name: s.name,
      similarity_score: Math.round(s.similarity_score * 100) / 100,
      exact_range: {
        start_line: s.line_start,
        end_line: s.line_end,
        total_lines: s.line_end - s.line_start + 1,
      },
      signature: s.signature,
      file_path: s.file_path,
    })),
    sibling_methods: fallback.sibling_methods,
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
