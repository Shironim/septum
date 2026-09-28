import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, basename } from "node:path";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { IngestionPipeline } from "../../core/ingestion/pipeline.ts";
import {
  SymbolLocator,
  type SymbolLocationResult,
} from "../../core/resolver/symbol-locator.ts";

export interface LocateSymbolArgs {
  query: string;
  domain?: string;
  workspace_path?: string;
}

export async function handleLocateSymbol(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: LocateSymbolArgs,
  pipeline?: IngestionPipeline,
  workspaceRoot?: string
) {
  if (!args.query) {
    throw new Error(
      "Missing required argument: 'query' (e.g. 'OrderController::calculateTotal' or error log snippet)"
    );
  }

  const root = workspaceRoot || process.cwd();

  // 1. Guarded Lazy Ingestion on Empty Catalog / Cold Start
  if (repo.countFiles() === 0 && pipeline) {
    try {
      await pipeline.run(config);
    } catch {
      // Ingestion fallback
    }

    if (repo.countFiles() === 0) {
      const diagnostic = {
        status: "NOT_INDEXED",
        found: false,
        query: args.query,
        message: `Workspace '${root}' belum terindeks dalam Septum catalog.`,
        suggested_action: {
          tool: "septum_register_domain",
          params: { name: "core", root: "src", ingest_now: true },
        },
        agent_guidance:
          "Panggil tool 'septum_register_domain(name: \"core\", root: \"src\", ingest_now: true)' untuk mendaftarkan dan mengindeks codebase ini, atau jalankan 'septum init' di terminal workspace.",
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(diagnostic, null, 2),
          },
        ],
        metadata: diagnostic,
      };
    }
  }

  const locator = new SymbolLocator(repo);
  let result: SymbolLocationResult = locator.locate(args.query, args.domain);

  // 2. JIT Delta Sync: Check if located file has changed on disk since last ingest
  if (result.found && result.file_path && pipeline) {
    const fullPath = isAbsolute(result.file_path)
      ? result.file_path
      : join(root, result.file_path);
    try {
      const reindexed = await pipeline.ingestFile(fullPath, config);
      if (reindexed) {
        result = locator.locate(args.query, args.domain);
      }
    } catch {
      // Silently fall back to existing result
    }
  }

  // 3. Fallback on Cache Miss: Search for candidate source files matching the query terms
  if (!result.found && pipeline) {
    try {
      const cleanTerm = args.query.replace(/[^a-zA-Z0-9_]/g, " ").trim().split(/\s+/)[0] || "";
      if (cleanTerm.length >= 3) {
        const candidateFiles = findCandidateFiles(root, cleanTerm);
        let anyReindexed = false;
        for (const candidate of candidateFiles) {
          const reindexed = await pipeline.ingestFile(candidate, config);
          if (reindexed) anyReindexed = true;
        }
        if (anyReindexed) {
          result = locator.locate(args.query, args.domain);
        }
      }
    } catch {
      // Ignore candidate scan errors
    }
  }

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

/**
 * Searches for potential candidate files whose names resemble parts of the query term.
 */
function findCandidateFiles(root: string, term: string): string[] {
  const matched: string[] = [];
  const lowerTerm = term.toLowerCase().replace(/_/g, "");
  const searchDirs = ["src", "app", "lib"].map((d) => join(root, d)).filter((d) => existsSync(d));

  function scan(dir: string, depth: number = 0) {
    if (depth > 4) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          scan(full, depth + 1);
        } else if (e.isFile() && /\.(ts|tsx|js|jsx|php|py|go)$/i.test(e.name)) {
          const lowerName = e.name.toLowerCase().replace(/[-_.]/g, "");
          if (lowerName.includes(lowerTerm) || lowerTerm.includes(lowerName.replace(/\.[^.]+$/, ""))) {
            matched.push(full);
            if (matched.length >= 5) return;
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  for (const sDir of searchDirs) {
    scan(sDir);
    if (matched.length >= 5) break;
  }

  return matched;
}

