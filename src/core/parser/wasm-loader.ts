import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";
import { WASM_ASSETS } from "./wasm-assets.ts";

const GRAMMAR_BY_KEY: Record<string, string> = {
  // Extensions
  ".ts": "tree-sitter-typescript.wasm",
  ".mts": "tree-sitter-typescript.wasm",
  ".cts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".php": "tree-sitter-php.wasm",
  ".py": "tree-sitter-python.wasm",
  ".go": "tree-sitter-go.wasm",
  ".rs": "tree-sitter-rust.wasm",
  ".java": "tree-sitter-java.wasm",
  ".cs": "tree-sitter-c_sharp.wasm",
  ".rb": "tree-sitter-ruby.wasm",
  // Language names
  ts: "tree-sitter-typescript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  js: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  php: "tree-sitter-php.wasm",
  py: "tree-sitter-python.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  golang: "tree-sitter-go.wasm",
  rs: "tree-sitter-rust.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  cs: "tree-sitter-c_sharp.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  c_sharp: "tree-sitter-c_sharp.wasm",
  rb: "tree-sitter-ruby.wasm",
  ruby: "tree-sitter-ruby.wasm",
};

let initPromise: Promise<boolean> | null = null;
let sharedParser: Parser | null = null;
const languageCache = new Map<string, Parser.Language>();
const languageLoadingPromises = new Map<string, Promise<Parser.Language | null>>();

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
  const normalized = langKeyOrPath.trim().toLowerCase();
  if (GRAMMAR_BY_KEY[normalized]) {
    return GRAMMAR_BY_KEY[normalized];
  }
  if (normalized.endsWith(".wasm")) {
    return normalized;
  }
  const ext = path.extname(normalized);
  if (ext && GRAMMAR_BY_KEY[ext]) {
    return GRAMMAR_BY_KEY[ext];
  }
  return null;
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
  const wasmFileName = resolveGrammarFileName(langKeyOrPath);
  if (!wasmFileName) {
    return null;
  }

  const cached = languageCache.get(wasmFileName);
  if (cached) {
    return cached;
  }

  const inFlight = languageLoadingPromises.get(wasmFileName);
  if (inFlight) {
    return inFlight;
  }

  const loadPromise = (async () => {
    try {
      const initialized = await ensureTreeSitterInitialized();
      if (!initialized) {
        return null;
      }

      const wasmPath = resolveWasmPath(wasmFileName, false);
      if (!wasmPath) {
        return null;
      }

      const wasmBytes = fs.readFileSync(wasmPath);
      const lang = await Parser.Language.load(wasmBytes);
      languageCache.set(wasmFileName, lang);
      return lang;
    } catch {
      return null;
    } finally {
      languageLoadingPromises.delete(wasmFileName);
    }
  })();

  languageLoadingPromises.set(wasmFileName, loadPromise);
  return loadPromise;
}

/**
 * Parses source content using web-tree-sitter and executes a visitor over the root SyntaxNode.
 * Guarantees 0 WASM memory leaks by always invoking `tree.delete()` inside `finally`.
 */
export async function parseWithTreeSitter<T>(
  langKey: string,
  content: string,
  visitor: (rootNode: Parser.SyntaxNode) => T
): Promise<T | null> {
  const language = await loadTreeSitterLanguage(langKey);
  if (!language || !sharedParser) {
    return null;
  }

  let tree: Parser.Tree | null = null;
  try {
    sharedParser.setLanguage(language);
    tree = sharedParser.parse(content);
    if (!tree) {
      return null;
    }
    return visitor(tree.rootNode);
  } catch {
    return null;
  } finally {
    if (tree) {
      tree.delete();
    }
  }
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
