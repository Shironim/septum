import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";
import { WASM_ASSETS } from "./wasm-assets.ts";
import { grammarFileForKey } from "./language-capabilities.ts";
import type { ParserDiagnostic, ParsedFileAST } from "../../types/index.ts";

let initPromise: Promise<boolean> | null = null;
let sharedParser: Parser | null = null;
const languageCache = new Map<string, Parser.Language>();
const languageLoadingPromises = new Map<string, Promise<LanguageResult>>();

function getModuleDir(): string {
  if (typeof import.meta.dir === "string") {
    return import.meta.dir;
  }
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Deterministic 4-tier WASM path resolver for both source execution and compiled binaries.
 */
export function resolveWasmPath(fileName: string, isCoreRuntime: boolean = false): string | null {
  const candidates: string[] = [];
  const relativeNodeModulesPath = isCoreRuntime
    ? path.join("node_modules", "web-tree-sitter", fileName)
    : path.join("node_modules", "tree-sitter-wasms", "out", fileName);

  // Tier 1: Explicit environment variable override
  const envDir = process.env.SEPTUM_WASM_DIR;
  if (envDir) {
    candidates.push(path.join(envDir, fileName));
    candidates.push(path.join(envDir, "out", fileName));
  }

  if (WASM_ASSETS[fileName]) candidates.push(WASM_ASSETS[fileName]);

  // Tier 2: Walk up from import.meta.dir to package root
  let currentDir = getModuleDir();
  for (let depth = 0; depth < 7; depth++) {
    candidates.push(path.join(currentDir, relativeNodeModulesPath));
    candidates.push(path.join(currentDir, "wasm", fileName));
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  // Tier 3: Relative to process.execPath (for `bun build --compile` standalone binaries)
  if (process.execPath) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, "wasm", fileName));
    candidates.push(path.join(execDir, fileName));
    candidates.push(path.join(execDir, "..", "wasm", fileName));
    candidates.push(path.join(execDir, relativeNodeModulesPath));
    candidates.push(path.join(execDir, "..", relativeNodeModulesPath));
  }

  // Tier 4: Fallback to process.cwd()/node_modules/...
  const cwd = process.cwd();
  candidates.push(path.join(cwd, relativeNodeModulesPath));
  candidates.push(path.join(cwd, "wasm", fileName));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore permission or stat errors on intermediate paths
    }
  }

  return null;
}

/**
 * Resolves a language key or file path/extension to its WASM grammar filename.
 */
export function resolveGrammarFileName(langKeyOrPath: string): string | null {
  return grammarFileForKey(langKeyOrPath);
}

/**
 * Initializes the core web-tree-sitter runtime once as a singleton.
 */
export async function ensureTreeSitterInitialized(): Promise<boolean> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const coreWasmPath = resolveWasmPath("tree-sitter.wasm", true);
      if (!coreWasmPath) {
        return false;
      }
      await Parser.init({
        locateFile: () => coreWasmPath,
      });
      if (!sharedParser) {
        sharedParser = new Parser();
      }
      return true;
    } catch {
      initPromise = null;
      return false;
    }
  })();

  return initPromise;
}

/**
 * Loads and caches a Tree-Sitter Language grammar from its WASM file.
 */
export async function loadTreeSitterLanguage(langKeyOrPath: string): Promise<Parser.Language | null> {
  const result = await loadLanguageResult(langKeyOrPath);
  return "language" in result ? result.language : null;
}

type LanguageResult = { language: Parser.Language } | { error: ParserDiagnostic };
async function loadLanguageResult(langKeyOrPath: string): Promise<LanguageResult> {
  const wasmFileName = resolveGrammarFileName(langKeyOrPath);
  if (!wasmFileName) {
    return { error: { code: "grammar_unsupported", message: `No grammar mapped for '${langKeyOrPath}'.` } };
  }

  const cached = languageCache.get(wasmFileName);
  if (cached) {
    return { language: cached };
  }

  const inFlight = languageLoadingPromises.get(wasmFileName);
  if (inFlight) {
    return inFlight;
  }

  const loadPromise = (async (): Promise<LanguageResult> => {
    try {
      const initialized = await ensureTreeSitterInitialized();
      if (!initialized) {
        return { error: { code: "runtime_unavailable", message: "Tree-sitter runtime initialization failed." } };
      }

      const wasmPath = resolveWasmPath(wasmFileName, false);
      if (!wasmPath) {
        return { error: { code: "grammar_missing", message: `Grammar asset not found: ${wasmFileName}` } };
      }

      const wasmBytes = fs.readFileSync(wasmPath);
      const lang = await Parser.Language.load(wasmBytes);
      languageCache.set(wasmFileName, lang);
      return { language: lang };
    } catch {
      return { error: { code: "grammar_invalid", message: `Cannot load grammar asset: ${wasmFileName}` } };
    } finally {
      languageLoadingPromises.delete(wasmFileName);
    }
  })();

  languageLoadingPromises.set(wasmFileName, loadPromise);
  return loadPromise;
}

/**
 * Parses source content using web-tree-sitter and executes a visitor over the root SyntaxNode.
 * Releases the parsed tree inside `finally`, including when the visitor throws.
 */
export async function parseWithTreeSitter<T>(
  langKey: string,
  content: string,
  visitor: (rootNode: Parser.SyntaxNode) => T,
  onFailure?: (diagnostic: ParserDiagnostic) => void
): Promise<T | null> {
  const loaded = await loadLanguageResult(langKey);
  if ("error" in loaded) {
    onFailure?.(loaded.error);
    return null;
  }
  if (!sharedParser) {
    onFailure?.({ code: "runtime_unavailable", message: "Tree-sitter parser unavailable." });
    return null;
  }
  const language = loaded.language;

  let tree: Parser.Tree | null = null;
  try {
    sharedParser.setLanguage(language);
    tree = sharedParser.parse(content);
    if (!tree) {
      onFailure?.({ code: "parse_failed", message: "Tree-sitter returned no tree." });
      return null;
    }
    try {
      return visitor(tree.rootNode);
    } catch {
      onFailure?.({ code: "extraction_failed", message: "AST visitor failed." });
      return null;
    }
  } catch {
    onFailure?.({ code: "parse_failed", message: "Tree-sitter parsing failed." });
    return null;
  } finally {
    if (tree) {
      tree.delete();
    }
  }
}

export async function parseSourceWithTreeSitter(
  langKey: string,
  content: string,
  visitor: (rootNode: Parser.SyntaxNode) => ParsedFileAST,
  fallback?: () => ParsedFileAST
): Promise<ParsedFileAST | null> {
  let failure: ParserDiagnostic | undefined;
  const result = await parseWithTreeSitter(langKey, content, rootNode => ({
    ...visitor(rootNode),
    status: rootNode.hasError ? "degraded" as const : "parsed" as const,
    extraction: { method: "tree-sitter" as const, coverage: "partial" as const },
    diagnostics: rootNode.hasError ? [{ code: "syntax_recovery" as const, message: "Grammar recovered from syntax errors; extraction may be incomplete." }] : [],
  }), diagnostic => { failure = diagnostic; });
  if (result || !fallback) return result;
  return {
    ...fallback(), status: "degraded",
    extraction: { method: "fallback", coverage: "partial" },
    diagnostics: failure ? [failure] : [],
  };
}

export function getNodeHeader(node: Parser.SyntaxNode): string {
  const body = node.childForFieldName("body");
  const end = body ?? node.children.findLast(child => child.type === "end");
  return (end ? node.text.slice(0, end.startIndex - node.startIndex) : node.text)
    .trim().replace(/;$/, "");
}

/**
 * Computes maximum control-flow nesting depth directly from a Tree-Sitter function/method AST node.
 * Base depth for a function/method body is 1.
 */
export function calculateAstControlFlowNesting(
  rootNode: Parser.SyntaxNode,
  controlNodeTypes: ReadonlySet<string>,
  boundaryNodeTypes?: ReadonlySet<string>
): number {
  let maxDepth = 1;

  function walk(node: Parser.SyntaxNode, currentDepth: number, isRoot: boolean): void {
    if (!isRoot && boundaryNodeTypes && boundaryNodeTypes.has(node.type)) {
      return;
    }

    let nextDepth = currentDepth;
    if (!isRoot && controlNodeTypes.has(node.type)) {
      nextDepth = currentDepth + 1;
      if (nextDepth > maxDepth) {
        maxDepth = nextDepth;
      }
    }

    for (const child of node.namedChildren) {
      walk(child, nextDepth, false);
    }
  }

  walk(rootNode, 1, true);
  return maxDepth;
}
