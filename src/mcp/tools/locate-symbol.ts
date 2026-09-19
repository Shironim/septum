import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import {
  SymbolLocator,
  type SymbolLocationResult,
} from "../../core/resolver/symbol-locator.ts";

export interface LocateSymbolArgs {
  query: string;
  domain?: string;
}

export function handleLocateSymbol(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: LocateSymbolArgs
) {
  if (!args.query) {
    throw new Error(
      "Missing required argument: 'query' (e.g. 'OrderController::calculateTotal' or error log snippet)"
    );
  }

  const locator = new SymbolLocator(repo);
  const result: SymbolLocationResult = locator.locate(args.query, args.domain);

  let formattedText = "";

  if (result.found) {
    formattedText = `=== SYMBOL LOCATED ===\n`;
    formattedText += `Status: FOUND (Exact Match)\n`;
    formattedText += `File: ${result.file_path}\n`;
    if (result.exact_symbol) {
      formattedText += `Symbol: ${result.exact_symbol.name} [${result.exact_symbol.kind.toUpperCase()}]\n`;
      formattedText += `Signature: ${result.exact_symbol.signature}\n`;
      formattedText += `Lines: ${result.exact_symbol.line_start} - ${result.exact_symbol.line_end}\n`;
    }
    if (result.sibling_methods && result.sibling_methods.length > 0) {
      formattedText += `\nSibling Methods in ${result.container_name || "Container"} (${result.sibling_methods.length}):\n`;
      formattedText += `  ${result.sibling_methods.join(", ")}\n`;
    }
  } else {
    formattedText = `=== SYMBOL NOT FOUND / DIAGNOSTIC RESOLUTION ===\n`;
    formattedText += `Status: NOT FOUND\n`;
    if (result.file_path) {
      formattedText += `Target File: ${result.file_path}\n`;
      formattedText += `Target Container: ${result.container_name || "Unknown"}\n`;
    }
    formattedText += `Message: ${result.message}\n`;

    if (result.sibling_methods && result.sibling_methods.length > 0) {
      formattedText += `\nExisting Methods in ${result.container_name || "Container"} (${result.sibling_methods.length}):\n`;
      formattedText += `  ${result.sibling_methods.join(", ")}\n`;
    }

    if (result.suggestions.length > 0) {
      formattedText += `\nTop Suggestions (Ranked by Similarity):\n`;
      for (const sug of result.suggestions) {
        const percent = Math.round(sug.similarity_score * 100);
        formattedText += `  • ${sug.name} [${percent}% match] -> lines ${sug.line_start}-${sug.line_end} (${sug.signature})\n`;
      }
    }
  }

  return {
    content: [
      {
        type: "text",
        text: formattedText.trim(),
      },
    ],
    metadata: result,
  };
}
