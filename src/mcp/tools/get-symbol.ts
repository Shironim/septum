import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { resolve } from "node:path";
import { computeContentHash } from "../../core/ingestion/hasher.ts";
import { isPathContained } from "../../core/resolver/path-resolver.ts";
import { readSourceFile } from "../../core/resources/source-files.ts";
import { SymbolLocator } from "../../core/resolver/symbol-locator.ts";
import type { GetSymbolArgs } from "../../types/index.ts";

export function handleGetSymbol(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetSymbolArgs,
  workspaceRoot?: string
) {
  const symbol = (args.symbol_ref?.name || args.symbol || (args as unknown as Record<string, unknown>).query || "").toString().trim();
  if (!symbol) {
    throw new Error(
      "Missing required argument: 'symbol' (e.g. 'OrderController::cancelOrder', 'OrderService', or 'cancelOrder')"
    );
  }

  if (args.symbol_ref) {
    const file = repo.getFileByPath(args.symbol_ref.file_path);
    if (!file || file.content_hash !== args.symbol_ref.indexed_content_hash) {
      return { content: [{ type: "text" as const, text: JSON.stringify({
        symbol, status: "stale_reference", found: false,
        message: "Declaration reference is stale; locate the symbol again.",
        ...(args.include_source ? { source_slice: { status: "stale", reason: "stale_reference" } } : {}),
      }) }] };
    }
  }
  const selectedCandidates = repo.findSymbolsByName(symbol, {
    domain: args.domain, filePath: args.file_path, reference: args.symbol_ref,
  });
  if (selectedCandidates.length > 1) {
    const candidates = selectedCandidates.map(candidate => ({
      name: candidate.name, file_path: candidate.file_path, kind: candidate.kind, signature: candidate.signature,
      start_line: candidate.line_start, end_line: candidate.line_end, symbol_ref: candidate.symbol_ref,
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify({
      symbol, status: "ambiguous", found: false, candidates,
      ...(args.include_source ? { source_slice: { status: "ambiguous", candidates } } : {}),
      message: "Multiple matching declarations; select a candidate with symbol_ref or narrow with file_path.",
    }, null, 2) }] };
  }

  const details = repo.getSymbolDetails(symbol, {
    domain: args.domain,
    filePath: args.file_path,
    reference: args.symbol_ref,
    // This inspection path reads the complete file for outbound-call inference; keep source requests bounded.
    includeDependencies: args.include_source ? false : args.include_dependencies,
    workspaceRoot: workspaceRoot || args.workspace_path,
  });

  if (details) {
    const payload: Record<string, unknown> = { ...details };
    if (args.include_source) {
      delete payload.dependencies_injected;
      delete payload.outbound_calls;
      delete payload.resolved_outbound_calls;
      delete payload.connected_files;
      const root = resolve(workspaceRoot || args.workspace_path || process.cwd());
      const file = repo.getFileByPath(details.file_path);
      const fullPath = resolve(root, details.file_path);
      if (!file) {
        payload.source_slice = { status: "unavailable", file_path: details.file_path, reason: "file_not_indexed" };
      } else if (!isPathContained(fullPath, root)) {
        payload.source_slice = { status: "out_of_scope", file_path: details.file_path };
      } else {
        try {
          const source = readSourceFile(fullPath);
          const currentHash = computeContentHash(source);
          if (currentHash !== file.content_hash) {
            payload.source_slice = {
              status: "stale",
              file_path: details.file_path,
              indexed_content_hash: file.content_hash,
              current_content_hash: currentHash,
              message: "File has been modified on disk since last indexed. Run 'septum sync' to synchronize AST coordinates.",
              action_required: "septum sync",
            };
          } else {
            const lineStarts = [0];
            const lineEnds: number[] = [];
            for (const match of source.matchAll(/\r\n|\n|\r/g)) {
              const offset = match.index!;
              lineEnds.push(offset);
              lineStarts.push(offset + match[0].length);
            }
            lineEnds.push(source.length);
            const startLine = args.source_start_line ?? details.exact_range.start_line;
            const limit = Math.min(args.source_line_limit ?? 120, 200);
            if (
              startLine < details.exact_range.start_line ||
              startLine > details.exact_range.end_line ||
              startLine > lineStarts.length
            ) {
              payload.source_slice = {
                status: "invalid_range",
                file_path: details.file_path,
                allowed_start_line: details.exact_range.start_line,
                allowed_end_line: details.exact_range.end_line,
              };
            } else {
              const endLine = Math.min(details.exact_range.end_line, startLine + limit - 1, lineStarts.length);
              const truncated = endLine < details.exact_range.end_line;
              payload.source_slice = {
                status: "current",
                file_path: details.file_path,
                indexed_content_hash: file.content_hash,
                current_content_hash: currentHash,
                start_line: startLine,
                end_line: endLine,
                text: source.slice(lineStarts[startLine - 1], lineEnds[endLine - 1]),
                truncated,
                related_dependency_analysis: "omitted_to_keep_source_read_bounded",
                ...(truncated ? { next_start_line: endLine + 1 } : {}),
              };
            }
          }
        } catch (error) {
          payload.source_slice = {
            status: "unavailable",
            file_path: details.file_path,
            reason: error instanceof Error && error.name === "SourceFileLimitError"
              ? "source_exceeds_read_limit"
              : "source_unavailable",
          };
        }
      }
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  // Fallback to fuzzy SymbolLocator to provide actionable hints
  const locator = new SymbolLocator(repo);
  const fallback = locator.locate(symbol, args.domain, { filePath: args.file_path, reference: args.symbol_ref });

  const payload = {
    symbol,
    found: false,
    message: `Symbol '${symbol}' was not found in the deterministic catalog.`,
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
    ...(args.include_source ? { source_slice: { status: "unavailable", reason: "symbol_not_found" } } : {}),
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
