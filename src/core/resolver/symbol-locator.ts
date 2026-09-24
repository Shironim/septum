import type { FileRecord, SymbolKind, SymbolRecord } from "../database/repository.ts";
import type { SeptumRepository } from "../database/repository.ts";

export interface ParsedSymbolQuery {
  raw: string;
  container?: string; // e.g. "OrderController" or "App\\Http\\Controllers\\OrderController"
  member?: string;    // e.g. "calculateTotal"
  kind?: SymbolKind;
}

export interface SuggestionMatch {
  name: string;
  kind: string;
  signature: string;
  line_start: number;
  line_end: number;
  similarity_score: number; // 0.0 - 1.0
  file_path?: string;
}

export interface SymbolLocationResult {
  query: string;
  parsed: ParsedSymbolQuery;
  found: boolean;
  file_path?: string;
  container_name?: string;
  exact_symbol?: {
    name: string;
    kind: string;
    signature: string;
    visibility: string;
    line_start: number;
    line_end: number;
  };
  sibling_methods?: string[];
  suggestions: SuggestionMatch[];
  message: string;
}

export class SymbolLocator {
  constructor(private repo: SeptumRepository) {}

  /**
   * Parse error log strings, method call syntax, or symbol names into container & member.
   * Examples:
   *  - "Method OrderController::calculateTotal() does not exist"
   *  - "Call to undefined method App\\Http\\Controllers\\OrderController::calculateTotal()"
   *  - "OrderController->calculateTotal()"
   *  - "OrderController.calculateTotal"
   *  - "OrderController"
   *  - "calculateTotal"
   */
  public parseQuery(rawQuery: string): ParsedSymbolQuery {
    const trimmed = rawQuery.trim();

    // 1. Error string matching: "Method X::y() does not exist" or "Call to undefined method X::y()"
    const methodNotExistMatch = trimmed.match(/(?:Method|method)\s+([A-Za-z0-9_\\\/\.]+)::([A-Za-z0-9_]+)\s*\(\)?/i);
    if (methodNotExistMatch) {
      return {
        raw: trimmed,
        container: methodNotExistMatch[1],
        member: methodNotExistMatch[2],
        kind: "method",
      };
    }

    // 2. Python / JS error: "'X' object has no attribute 'y'"
    const pyAttrMatch = trimmed.match(/['"]?([A-Za-z0-9_]+)['"]?\s+object has no attribute\s+['"]?([A-Za-z0-9_]+)['"]?/i);
    if (pyAttrMatch) {
      return {
        raw: trimmed,
        container: pyAttrMatch[1],
        member: pyAttrMatch[2],
      };
    }

    // 3. Class::member or Class->member or Class.member
    const staticCallMatch = trimmed.match(/^([A-Za-z0-9_\\\/\.]+)::([A-Za-z0-9_]+)(?:\(\))?$/);
    if (staticCallMatch) {
      return {
        raw: trimmed,
        container: staticCallMatch[1],
        member: staticCallMatch[2],
        kind: "method",
      };
    }

    const arrowCallMatch = trimmed.match(/^([A-Za-z0-9_\\\/\.]+)->([A-Za-z0-9_]+)(?:\(\))?$/);
    if (arrowCallMatch) {
      return {
        raw: trimmed,
        container: arrowCallMatch[1],
        member: arrowCallMatch[2],
        kind: "method",
      };
    }

    const dotCallMatch = trimmed.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)(?:\(\))?$/);
    if (dotCallMatch) {
      return {
        raw: trimmed,
        container: dotCallMatch[1],
        member: dotCallMatch[2],
      };
    }

    // 4. Function call: "calculateTotal()"
    const funcMatch = trimmed.match(/^([A-Za-z0-9_]+)\(\)$/);
    if (funcMatch) {
      return {
        raw: trimmed,
        member: funcMatch[1],
        kind: "function",
      };
    }

    // 5. Bare word: could be class or function
    return {
      raw: trimmed,
      member: trimmed,
    };
  }

  /**
   * Locate the symbol or diagnostic resolution in the database.
   */
  public locate(rawQuery: string, domainFilter?: string): SymbolLocationResult {
    const parsed = this.parseQuery(rawQuery);

    // If a container (Class / Interface) is specified
    if (parsed.container) {
      return this.locateWithContainer(parsed, domainFilter);
    }

    // If only member or bare name is provided
    return this.locateBareMember(parsed, domainFilter);
  }

  private locateWithContainer(
    parsed: ParsedSymbolQuery,
    domainFilter?: string
  ): SymbolLocationResult {
    const containerQuery = parsed.container!;
    const simpleContainerName = containerQuery.split(/\\|\//).pop() || containerQuery;
    const memberName = parsed.member;

    // Search for container in symbols table or files table
    const containers = this.repo.findContainers(simpleContainerName);

    if (containers.length === 0) {
      // Container not found directly: search for fuzzy container matches across the catalog
      const allSymbols = this.repo.getAllSymbolsWithFiles();
      const containerCandidates = allSymbols.filter((s) =>
        ["class", "interface", "trait", "enum", "struct"].includes(s.kind)
      );

      // Score containers by similarity
      const scoredContainers = containerCandidates
        .map((s) => {
          const bare = s.name.includes("::")
            ? s.name.split("::")[0]
            : s.name.split(/\\|\//).pop() || s.name;
          const score = calculateSimilarity(simpleContainerName, bare);
          return {
            name: s.name,
            bare,
            kind: s.kind,
            signature: s.signature,
            line_start: s.line_start,
            line_end: s.line_end,
            file_path: s.file_path,
            similarity_score: Math.round(score * 100) / 100,
          };
        })
        .filter((c) => c.similarity_score >= 0.3)
        .sort((a, b) => b.similarity_score - a.similarity_score);

      // Deduplicate by name + file_path
      const seenContainers = new Set<string>();
      const uniqueContainers = scoredContainers.filter((c) => {
        const key = `${c.name}@${c.file_path}`;
        if (seenContainers.has(key)) return false;
        seenContainers.add(key);
        return true;
      }).slice(0, 5);

      // If a member was requested, prioritize methods within top fuzzy candidate containers
      let memberSuggestions: SuggestionMatch[] = [];
      if (memberName) {
        const topCandidateFilePaths = new Set(uniqueContainers.map((c) => c.file_path));

        const candidateMethods = allSymbols.filter(
          (s) =>
            (s.kind === "method" || s.kind === "function") &&
            topCandidateFilePaths.has(s.file_path)
        );

        const methodsToScore =
          candidateMethods.length > 0
            ? candidateMethods
            : allSymbols
                .filter(
                  (s) =>
                    (s.kind === "method" || s.kind === "function") &&
                    Math.abs(s.name.length - memberName.length) <= 8
                )
                .slice(0, 100);

        memberSuggestions = methodsToScore
          .map((s) => {
            const bare = s.name.includes("::") ? s.name.split("::")[1] : s.name;
            const score = calculateSimilarity(memberName, bare);
            return {
              name: s.name,
              kind: s.kind,
              signature: `${s.signature} (${s.file_path}:${s.line_start})`,
              line_start: s.line_start,
              line_end: s.line_end,
              similarity_score: Math.round(score * 100) / 100,
              file_path: s.file_path,
            };
          })
          .filter((s) => s.similarity_score >= 0.35)
          .sort((a, b) => b.similarity_score - a.similarity_score)
          .slice(0, 5);
      }

      const suggestions: SuggestionMatch[] = uniqueContainers.map((c) => ({
        name: c.name,
        kind: c.kind,
        signature: `${c.signature || c.kind} (${c.file_path}:${c.line_start})`,
        line_start: c.line_start,
        line_end: c.line_end,
        similarity_score: c.similarity_score,
        file_path: c.file_path,
      }));

      // Combine container suggestions with member suggestions if available
      const combinedSuggestions = [...suggestions, ...memberSuggestions]
        .sort((a, b) => b.similarity_score - a.similarity_score)
        .slice(0, 7);

      const topSuggestion = combinedSuggestions.length > 0 ? combinedSuggestions[0].name : null;
      const hint = topSuggestion
        ? ` Container '${containerQuery}' was not found. Did you mean '${topSuggestion}'?`
        : ` Container '${containerQuery}' was not found in cataloged files.`;

      return {
        query: parsed.raw,
        parsed,
        found: false,
        suggestions: combinedSuggestions,
        message: `${hint} Run 'septum ingest' if this file was recently added.`,
      };
    }

    // Pick primary container matching
    const primary = containers[0];
    const fileSymbols = this.repo.getSymbolsByFileId(primary.file.id);

    // Extract methods in this container / file
    const methodSymbols = fileSymbols.filter(
      (s) => s.kind === "method" || s.kind === "function"
    );

    const siblingMethodNames = Array.from(
      new Set(
        methodSymbols.map((m) => {
          if (m.name.includes("::")) {
            return m.name.split("::")[1];
          }
          return m.name;
        })
      )
    );

    if (!memberName) {
      // User only asked for the container
      return {
        query: parsed.raw,
        parsed,
        found: true,
        file_path: primary.file.path,
        container_name: simpleContainerName,
        exact_symbol: primary.symbol
          ? {
              name: primary.symbol.name,
              kind: primary.symbol.kind,
              signature: primary.symbol.signature,
              visibility: primary.symbol.visibility,
              line_start: primary.symbol.line_start,
              line_end: primary.symbol.line_end,
            }
          : undefined,
        sibling_methods: siblingMethodNames,
        suggestions: [],
        message: `Found container '${simpleContainerName}' in ${primary.file.path} with ${siblingMethodNames.length} methods.`,
      };
    }

    // Search for exact member match
    const exactMatch = methodSymbols.find((s) => {
      const bareName = s.name.includes("::") ? s.name.split("::")[1] : s.name;
      return bareName.toLowerCase() === memberName.toLowerCase();
    });

    if (exactMatch) {
      return {
        query: parsed.raw,
        parsed,
        found: true,
        file_path: primary.file.path,
        container_name: simpleContainerName,
        exact_symbol: {
          name: exactMatch.name,
          kind: exactMatch.kind,
          signature: exactMatch.signature,
          visibility: exactMatch.visibility,
          line_start: exactMatch.line_start,
          line_end: exactMatch.line_end,
        },
        sibling_methods: siblingMethodNames,
        suggestions: [],
        message: `Exact method '${memberName}' found in ${primary.file.path} at line ${exactMatch.line_start}.`,
      };
    }

    // Member NOT found in container: calculate fuzzy suggestions
    const suggestions: SuggestionMatch[] = methodSymbols
      .map((s) => {
        const bareName = s.name.includes("::") ? s.name.split("::")[1] : s.name;
        const score = calculateSimilarity(memberName, bareName);
        return {
          name: bareName,
          kind: s.kind,
          signature: s.signature,
          line_start: s.line_start,
          line_end: s.line_end,
          similarity_score: Math.round(score * 100) / 100,
        };
      })
      .filter((s) => s.similarity_score >= 0.25)
      .sort((a, b) => b.similarity_score - a.similarity_score)
      .slice(0, 5);

    const topSuggestion = suggestions.length > 0 ? suggestions[0].name : null;
    const hint = topSuggestion
      ? ` Method '${memberName}' does not exist! Did you mean '${topSuggestion}'?`
      : ` Method '${memberName}' does not exist.`;

    return {
      query: parsed.raw,
      parsed,
      found: false,
      file_path: primary.file.path,
      container_name: simpleContainerName,
      sibling_methods: siblingMethodNames,
      suggestions,
      message: `File: ${primary.file.path}.${hint} Available methods: [${siblingMethodNames.join(", ")}].`,
    };
  }

  private locateBareMember(
    parsed: ParsedSymbolQuery,
    domainFilter?: string
  ): SymbolLocationResult {
    const targetName = parsed.member!;
    const directMatches = this.repo.findSymbolsByName(targetName);

    if (directMatches.length > 0) {
      const first = directMatches[0];
      return {
        query: parsed.raw,
        parsed,
        found: true,
        file_path: first.file_path,
        container_name: first.name.includes("::") ? first.name.split("::")[0] : undefined,
        exact_symbol: {
          name: first.name,
          kind: first.kind,
          signature: first.signature,
          visibility: first.visibility,
          line_start: first.line_start,
          line_end: first.line_end,
        },
        suggestions: [],
        message: `Found exact symbol '${first.name}' in ${first.file_path}:${first.line_start}`,
      };
    }

    // If bare name is a class name
    const containers = this.repo.findContainers(targetName);
    if (containers.length > 0) {
      const primary = containers[0];
      const fileSymbols = this.repo.getSymbolsByFileId(primary.file.id);
      const siblingMethods = fileSymbols
        .filter((s) => s.kind === "method" || s.kind === "function")
        .map((s) => (s.name.includes("::") ? s.name.split("::")[1] : s.name));

      return {
        query: parsed.raw,
        parsed,
        found: true,
        file_path: primary.file.path,
        container_name: targetName,
        exact_symbol: primary.symbol
          ? {
              name: primary.symbol.name,
              kind: primary.symbol.kind,
              signature: primary.symbol.signature,
              visibility: primary.symbol.visibility,
              line_start: primary.symbol.line_start,
              line_end: primary.symbol.line_end,
            }
          : undefined,
        sibling_methods: Array.from(new Set(siblingMethods)),
        suggestions: [],
        message: `Found container '${targetName}' in ${primary.file.path}`,
      };
    }

    // Nothing found directly: Search all symbols for fuzzy suggestions
    const allSymbols = this.repo.getAllSymbolsWithFiles();
    const suggestions: SuggestionMatch[] = allSymbols
      .map((s) => {
        const bareName = s.name.includes("::") ? s.name.split("::")[1] : s.name;
        const scoreBare = calculateSimilarity(targetName, bareName);
        const scoreFull = calculateSimilarity(targetName, s.name);
        const score = Math.max(scoreBare, scoreFull);
        return {
          name: s.name,
          kind: s.kind,
          signature: `${s.signature} (${s.file_path}:${s.line_start})`,
          line_start: s.line_start,
          line_end: s.line_end,
          similarity_score: Math.round(score * 100) / 100,
          file_path: s.file_path,
        };
      })
      .filter((s) => s.similarity_score >= 0.3)
      .sort((a, b) => b.similarity_score - a.similarity_score)
      .slice(0, 5);

    return {
      query: parsed.raw,
      parsed,
      found: false,
      suggestions,
      message: `Symbol '${targetName}' not found. ${suggestions.length > 0 ? `Did you mean '${suggestions[0].name}'?` : ""}`,
    };
  }
}

/**
 * Enhanced similarity matching:
 * Combines Damerau-Levenshtein distance (handling typos & transpositions),
 * prefix/suffix matching, substring inclusion, and token Jaccard similarity.
 */
export function calculateSimilarity(source: string, target: string): number {
  const s1 = source.toLowerCase();
  const s2 = target.toLowerCase();

  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  // Prefix bonus: highly relevant for autocomplete-style / partial searches
  let prefixBonus = 0;
  if (s2.startsWith(s1) || s1.startsWith(s2)) {
    const minLen = Math.min(s1.length, s2.length);
    const maxLen = Math.max(s1.length, s2.length);
    prefixBonus = 0.25 * (minLen / maxLen);
  }

  // Substring inclusion bonus
  let substringBonus = 0;
  if (s2.includes(s1) || s1.includes(s2)) {
    const minLen = Math.min(s1.length, s2.length);
    const maxLen = Math.max(s1.length, s2.length);
    substringBonus = 0.3 * (minLen / maxLen);
  }

  // Token-based matching (CamelCase, snake_case, kebab-case, namespaces)
  const tokenize = (str: string) =>
    str
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[\s_\-\.\:\/\\]+/)
      .filter((t) => t.length > 1);

  const t1 = tokenize(source);
  const t2 = tokenize(target);
  let tokenBonus = 0;
  if (t1.length > 0 && t2.length > 0) {
    const sharedTokens = t1.filter((token) =>
      t2.some((t) => t.includes(token) || token.includes(t))
    );
    const allUniqueTokens = new Set([...t1, ...t2]);
    const jaccard = sharedTokens.length / (allUniqueTokens.size || 1);
    tokenBonus = jaccard * 0.35;
  }

  // Damerau-Levenshtein Matrix
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      let minCost = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );

      // Transposition check (Damerau)
      if (
        i > 1 &&
        j > 1 &&
        s1[i - 1] === s2[j - 2] &&
        s1[i - 2] === s2[j - 1]
      ) {
        minCost = Math.min(minCost, matrix[i - 2][j - 2] + 1);
      }

      matrix[i][j] = minCost;
    }
  }

  const distance = matrix[len1][len2];
  const maxLen = Math.max(len1, len2);
  const rawSimilarity = 1.0 - distance / maxLen;

  const totalScore = rawSimilarity + prefixBonus + substringBonus + tokenBonus;
  return Math.min(1.0, Math.max(0.0, totalScore));
}
