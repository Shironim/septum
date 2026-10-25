import type { SymbolRecord, SymbolReference } from "../../types/index.ts";
import { getLanguageCapability } from "../parser/language-capabilities.ts";

type IndexedSymbol = SymbolRecord & { file_path: string; indexed_content_hash: string };

export function symbolReference(symbol: IndexedSymbol): SymbolReference {
  const language = getLanguageCapability(symbol.file_path)?.id ?? "unknown";
  let receiver: string | undefined;
  let container = symbol.name.match(/^(.*)(?:::|[.#])[^:.#]+$/)?.[1];
  if (language === "go" && symbol.kind === "method") {
    const receiverClause = symbol.signature.match(/^\s*func\s*\(([^)]+)\)/)?.[1]?.trim();
    if (receiverClause) {
      const typeMatch = receiverClause.match(/^(?:[a-zA-Z0-9_]+\s+)?(\*?[a-zA-Z0-9_]+(?:\[[^\]]*\])?)$/);
      if (typeMatch) {
        receiver = typeMatch[1];
      } else {
        const spaceIdx = receiverClause.indexOf(" ");
        receiver = spaceIdx !== -1 ? receiverClause.slice(spaceIdx + 1).trim() : receiverClause;
      }
      container = receiver?.replace(/^\*/, "").replace(/\[.*\]$/, "");
    }
  }
  return {
    file_path: symbol.file_path, language, name: symbol.name, kind: symbol.kind,
    signature: symbol.signature, start_line: symbol.line_start, end_line: symbol.line_end,
    indexed_content_hash: symbol.indexed_content_hash,
    ...(container ? { container } : {}), ...(receiver ? { receiver } : {}),
  };
}

export function matchesSymbolName(symbol: IndexedSymbol, query: string): boolean {
  const ref = symbolReference(symbol);
  const normalize = (name: string) => {
    const plain = name.replace(/\(\)$/, "");
    return ref.language === "ruby" ? plain : plain.replace(/->|[.#]/g, "::");
  };
  const target = normalize(query);
  const name = normalize(symbol.name);
  if (name === target || name.endsWith(`::${target}`) || name.endsWith(`\\${target}`)) return true;
  if (!/::|[.#\\]/.test(target) && name.split(/::|[.#\\]/).pop() === target) return true;
  if (ref.receiver && ref.container) {
    if (`${ref.container}::${name}` === target) return true;
    if (`${ref.receiver}::${name}` === target || `(${ref.receiver})::${name}` === target) return true;
  }
  return false;
}

// shortcut: identical signatures/ranges on one line remain ambiguous; add persisted columns when exact column selection is needed.
export function matchesSymbolReference(actual: SymbolReference, expected: SymbolReference): boolean {
  return actual.file_path === expected.file_path && actual.name === expected.name && actual.kind === expected.kind
    && actual.signature === expected.signature && actual.start_line === expected.start_line && actual.end_line === expected.end_line
    && actual.indexed_content_hash === expected.indexed_content_hash && actual.language === expected.language;
}
