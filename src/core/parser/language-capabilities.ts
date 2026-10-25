import * as path from "node:path";
import grammarPackage from "tree-sitter-wasms/package.json";

// Keep this revision aligned with ingestion invalidation; coverage is never implied by parse success.
export const PARSER_REVISION = "4";

type LanguageDefinition = {
  id: string;
  extensions: string[];
  aliases: string[];
  extractor: string | null;
  method: "tree-sitter" | "template-scanner" | "embedded-script" | "unsupported";
  grammar?: string;
  grammarOverrides?: Record<string, string>;
  limits: string;
};

export const LANGUAGE_CAPABILITIES: readonly LanguageDefinition[] = [
  { id: "blade", extensions: [".blade.php"], aliases: [], extractor: "blade", method: "template-scanner", limits: "Literal directives/components only; no PHP or template syntax validation." },
  { id: "typescript", extensions: [".ts", ".tsx", ".mts", ".cts"], aliases: ["ts", "tsx"], extractor: "typescript", method: "tree-sitter", grammar: "typescript", grammarOverrides: { ".tsx": "tsx", tsx: "tsx" }, limits: "Selected declarations/imports; no type checking or complete module resolution." },
  { id: "javascript", extensions: [".js", ".jsx", ".mjs", ".cjs"], aliases: ["js", "jsx"], extractor: "typescript", method: "tree-sitter", grammar: "javascript", limits: "Selected declarations/imports; dynamic targets and module conditions are incomplete." },
  { id: "php", extensions: [".php"], aliases: [], extractor: "php", method: "tree-sitter", grammar: "php", limits: "Selected declarations/imports; partial PSR-4/domain resolution, no runtime reflection." },
  { id: "python", extensions: [".py"], aliases: ["py"], extractor: "python", method: "tree-sitter", grammar: "python", limits: "Selected declarations/imports; package resolution and dynamic attributes incomplete." },
  { id: "go", extensions: [".go"], aliases: ["golang"], extractor: "go", method: "tree-sitter", grammar: "go", limits: "Selected declarations/imports; no complete module/package or receiver resolution." },
  { id: "rust", extensions: [".rs"], aliases: ["rs"], extractor: "rust", method: "tree-sitter", grammar: "rust", limits: "Selected items/use declarations; no Cargo resolution, macro expansion or trait dispatch proof." },
  { id: "java", extensions: [".java"], aliases: [], extractor: "java", method: "tree-sitter", grammar: "java", limits: "Selected declarations; imports currently marked external, no JVM package resolution." },
  { id: "csharp", extensions: [".cs"], aliases: ["cs", "c_sharp"], extractor: "csharp", method: "tree-sitter", grammar: "c_sharp", limits: "Regression support for selected declarations; imports marked external, no assembly resolution." },
  { id: "ruby", extensions: [".rb"], aliases: ["rb"], extractor: "ruby", method: "tree-sitter", grammar: "ruby", limits: "Selected declarations/requires; no load-order or metaprogramming evaluation." },
  { id: "frontend", extensions: [".vue", ".astro", ".svelte"], aliases: [], extractor: "frontend", method: "embedded-script", limits: "Scans script/frontmatter as TypeScript; no whole-template AST validation." },
  { id: "kotlin", extensions: [".kt"], aliases: [], extractor: null, method: "unsupported", limits: "Recognized for unsupported-file diagnostics; no registered grammar or extractor." },
  { id: "scala", extensions: [".scala"], aliases: [], extractor: null, method: "unsupported", limits: "Recognized only; no registered grammar or extractor." },
  { id: "zig", extensions: [".zig"], aliases: [], extractor: null, method: "unsupported", limits: "Recognized only; no registered grammar or extractor." },
];

export function getLanguageCapability(filePath: string): LanguageDefinition | undefined {
  const lower = filePath.toLowerCase();
  return LANGUAGE_CAPABILITIES.find(language => language.extensions.some(ext => lower.endsWith(ext)));
}

export function grammarFileForKey(keyOrPath: string): string | null {
  const key = keyOrPath.trim().toLowerCase();
  if (key.endsWith(".wasm")) return key;
  const language = LANGUAGE_CAPABILITIES.find(l => l.id === key || l.aliases.includes(key))
    ?? getLanguageCapability(key);
  if (!language?.grammar) return null;
  const grammar = language.grammarOverrides?.[key] ?? language.grammarOverrides?.[path.extname(key)] ?? language.grammar;
  return `tree-sitter-${grammar}.wasm`;
}

export function getParserCapabilities(full: boolean) {
  const common = {
    parser_revision: PARSER_REVISION,
    grammar_package: `${grammarPackage.name}@${grammarPackage.version}`,
    coverage: "partial",
    status_contract: "parsed = parser/scanner completed; degraded = recovery/fallback; unsupported = no extractor. None implies complete extraction or runtime correctness.",
  };
  return full ? {
    ...common,
    languages: LANGUAGE_CAPABILITIES.map(l => ({
      id: l.id, extensions: l.extensions, extractor: l.extractor, method: l.method,
      coverage: l.extractor ? "partial" : "none",
      grammars: [...new Set(l.extensions.map(grammarFileForKey).filter(Boolean))],
      limits: l.limits,
      evidence: l.method === "tree-sitter" ? "tests/unit/language-capabilities.test.ts; tests/unit/parser-recovery.test.ts" : "tests/unit/language-capabilities.test.ts",
    })),
  } : {
    ...common,
    languages: Object.fromEntries(LANGUAGE_CAPABILITIES.map(l => [l.id, l.method])),
    detail_hint: "Use detail_level='full' for extensions, grammar assets and per-language limits.",
  };
}
