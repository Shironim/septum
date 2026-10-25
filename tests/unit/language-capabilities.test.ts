import { LANGUAGE_CAPABILITIES } from "../../src/core/parser/language-capabilities.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";
import { parseSourceWithTreeSitter, resolveGrammarFileName } from "../../src/core/parser/wasm-loader.ts";
import { WASM_ASSETS } from "../../src/core/parser/wasm-assets.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { handleGetDomainCatalog } from "../../src/mcp/tools/get-domain-catalog.ts";

const fixtures = [
  ["sample.ts", "export function okay() {}"],
  ["sample.tsx", "export function okay() { return <div />; }"],
  ["sample.js", "export function okay() {}"],
  ["sample.php", "<?php function okay() {}"],
  ["sample.py", "def okay():\n    pass"],
  ["sample.go", "package sample\nfunc Okay() {}"],
  ["sample.rs", "pub fn okay() {}"],
  ["Sample.java", "class Okay {}"],
  ["Sample.cs", "class Okay {}"],
  ["sample.rb", "class Okay\nend"],
] as const;

function catalog(full = false, registered = false, domain?: string) {
  const db = new SeptumDatabase(":memory:");
  try {
    const repo = new SeptumRepository(db.raw);
    const config = ConfigLoader.getDefaultConfig();
    if (registered) repo.upsertDomain("core", { root: "src", archetypes: {}, allowed_dependencies: [], forbidden_dependencies: [] });
    return JSON.parse(handleGetDomainCatalog(repo, config, { detail_level: full ? "full" : "compact", domain }, "/tmp").content[0].text);
  } finally { db.close(); }
}

describe("language capability contract", () => {
  const engine = new ASTParserEngine();
  for (const [file, source] of fixtures) {
    it(`reports partial AST coverage separately from parse success for ${file}`, async () => {
      expect(ASTParserEngine.isSourceFile(file.toUpperCase())).toBe(true);
      expect(WASM_ASSETS[resolveGrammarFileName(file)!]).toBeDefined();
      const result = await engine.parseFile(file, source);
      expect(result.status).toBe("parsed");
      expect(result.extraction).toEqual({ method: "tree-sitter", coverage: "partial" });
      expect(result.diagnostics).toEqual([]);
      expect(result.symbols.length).toBeGreaterThan(0);
    });
  }
  it("keeps all extension aliases and packaged grammar declarations aligned", async () => {
    const declared = new Set<string>();
    for (const language of LANGUAGE_CAPABILITIES.filter(l => l.method === "tree-sitter")) {
      const fixture = fixtures.find(([file]) => file.endsWith(language.extensions[0]))!;
      for (const ext of language.extensions) {
        const grammar = resolveGrammarFileName(`sample${ext}`)!;
        declared.add(grammar);
        expect(WASM_ASSETS[grammar]).toBeDefined();
        expect((await engine.parseFile(`sample${ext.toUpperCase()}`, fixture[1])).status).toBe("parsed");
      }
      for (const alias of [language.id, ...language.aliases]) {
        expect(WASM_ASSETS[resolveGrammarFileName(alias)!]).toBeDefined();
      }
    }
    expect([...declared].sort()).toEqual(Object.keys(WASM_ASSETS).filter(k => k !== "tree-sitter.wasm").sort());
  });
  it("retains custom extractor registration without claiming an AST method", async () => {
    const custom = new ASTParserEngine();
    custom.registerExtractor({ canHandle: file => file.endsWith(".custom"), extract: async () => ({ symbols: [], dependencies: [] }) });
    const result = await custom.parseFile("sample.custom", "");
    expect(result.status).toBe("parsed");
    expect(result.extraction?.method).toBe("fallback");
  });
  it("reports visitor failure and releases the tree for a subsequent parse", async () => {
    const result = await parseSourceWithTreeSitter("typescript", "function okay() {}", () => { throw new Error("fixture visitor failure"); }, () => ({ symbols: [], dependencies: [] }));
    expect(result?.status).toBe("degraded");
    expect(result?.diagnostics?.[0].code).toBe("extraction_failed");
    expect((await engine.parseFile("sample.ts", "function okay() {}" )).status).toBe("parsed");
  });
  it("keeps recognized but unimplemented languages unsupported", async () => {
    for (const ext of ["kt", "scala", "zig"]) {
      expect(ASTParserEngine.isSourceFile(`sample.${ext}`)).toBe(true);
      expect(resolveGrammarFileName(`sample.${ext}`)).toBeNull();
      const result = await engine.parseFile(`sample.${ext}`, "class Example {}");
      expect(result.status).toBe("unsupported");
      expect(result.diagnostics?.[0].code).toBe("extractor_unavailable");
      expect(result.extraction?.coverage).toBe("none");
    }
    expect(ASTParserEngine.isSourceFile("notes.md")).toBe(false);
  });
  it("labels syntax recovery independently of fallback", async () => {
    const result = await engine.parseFile("broken.ts", "function broken( {");
    expect(result.status).toBe("degraded");
    expect(result.extraction?.method).toBe("tree-sitter");
    expect(result.diagnostics?.[0].code).toBe("syntax_recovery");
  });
  it("distinguishes an unknown grammar from a missing or corrupt asset", async () => {
    const empty = () => ({ symbols: [], dependencies: [] });
    const unknown = await parseSourceWithTreeSitter("unknown-language", "", empty, empty);
    const missing = await parseSourceWithTreeSitter("septum-not-installed.wasm", "", empty, empty);
    const root = mkdtempSync(join(tmpdir(), "septum-corrupt-grammar-"));
    let corrupt;
    try {
      const asset = join(root, "septum-corrupt.wasm");
      writeFileSync(asset, "invalid wasm");
      WASM_ASSETS["septum-corrupt.wasm"] = asset;
      corrupt = await parseSourceWithTreeSitter("septum-corrupt.wasm", "", empty, empty);
    } finally {
      delete WASM_ASSETS["septum-corrupt.wasm"];
      rmSync(root, { recursive: true, force: true });
    }
    expect(unknown?.diagnostics?.[0].code).toBe("grammar_unsupported");
    expect(missing?.diagnostics?.[0].code).toBe("grammar_missing");
    expect(corrupt?.diagnostics?.[0].code).toBe("grammar_invalid");
    for (const result of [unknown, missing, corrupt]) {
      expect(result?.status).toBe("degraded");
      expect(result?.extraction).toEqual({ method: "fallback", coverage: "partial" });
    }
  });
  it("does not describe template scanners as whole-file AST parsers", async () => {
    for (const file of ["view.blade.php", "view.vue", "view.astro", "view.svelte"]) {
      const result = await engine.parseFile(file, "<p>Hello</p>");
      expect(result.extraction?.coverage).toBe("partial");
      expect(result.extraction?.method).not.toBe("tree-sitter");
    }
  });
  it("publishes compact and full capabilities for empty, macro and domain catalogs", () => {
    for (const [registered, domain] of [[false, undefined], [true, undefined], [true, "core"], [true, "missing"]] as const) {
      const compact = catalog(false, registered, domain).parser_capabilities;
      const full = catalog(true, registered, domain).parser_capabilities;
      expect(compact.languages.kotlin).toBe("unsupported");
      expect(compact.languages.csharp).toBe("tree-sitter");
      expect(full.languages.find((l: any) => l.id === "typescript").extensions).toContain(".tsx");
      expect(full.semantic_adapters.map((a: any) => a.id).sort()).toEqual(["django", "elysia", "express", "fastapi", "fastify", "flask", "golang", "hono", "laravel", "mcp-cli", "nestjs", "symfony"]);
      expect(full.languages.every((l: any) => l.coverage !== "complete")).toBe(true);
    }
  });
});
