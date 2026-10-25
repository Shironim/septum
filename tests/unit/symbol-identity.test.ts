import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { computeContentHash } from "../../src/core/ingestion/hasher.ts";
import { SymbolToolSchema } from "../../src/mcp/schemas.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";

describe("declaration identity and source selection", () => {
  let root: string, db: SeptumDatabase, repo: SeptumRepository;
  const config = ConfigLoader.getDefaultConfig();
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "septum-identity-")); db = new SeptumDatabase(":memory:"); repo = new SeptumRepository(db.raw); });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  async function index(file: string, source: string, domain = "core") {
    const domainId = repo.upsertDomain(domain, { root: "." });
    const ast = await new ASTParserEngine().parseFile(file, source);
    expect(ast.status).toBe("parsed");
    writeFileSync(join(root, file), source);
    const id = repo.upsertFile(domainId, file, "service", computeContentHash(source), source.split("\n").length);
    repo.replaceFileSymbols(id, ast.symbols);
  }
  async function tool(args: Record<string, unknown>) {
    return JSON.parse((await handleSymbolTool(repo, config, SymbolToolSchema.parse(args), undefined, root)).content[0].text);
  }
  const java = "class Order {\n  public int save(int id) { return id; }\n  public String save(String id) { return id; }\n}";

  it("returns selectable overload candidates even without a source request", async () => {
    await index("Order.java", java);
    for (const action of ["locate", "inspect"]) {
      const result = await tool({ action, query: "Order.save", file_path: "Order.java" });
      expect(result.status).toBe("ambiguous");
      expect(result.found).toBe(false);
      expect(result.candidates).toHaveLength(2);
      const selected = await tool({ action: "inspect", symbol_ref: result.candidates[1].symbol_ref, include_source: true });
      expect(selected.signature).toContain("String id");
      expect(selected.source_slice.text).toContain("String save");
      expect(selected.symbol_ref).toEqual(result.candidates[1].symbol_ref);
    }
    expect(repo.getSymbolDetails("Order.save")).toBeNull();
  });
  it("discriminates overloads on the same line using their signatures", async () => {
    await index("Order.java", java.replaceAll("\n", " "));
    const result = await tool({ action: "inspect", query: "Order.save", include_source: true });
    expect(result.source_slice.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
    const selected = await tool({ action: "inspect", symbol_ref: result.candidates.find((c: any) => c.signature.includes("int id")).symbol_ref });
    expect(selected.signature).toContain("int id");
  });
  it("uses Go receiver identity without renaming legacy indexed method names", async () => {
    await index("service.go", "package service\ntype A struct{}\ntype B struct{}\nfunc (a *A) Save() {}\nfunc (b B) Save() {}");
    const result = await tool({ action: "locate", query: "Save" });
    expect(result.status).toBe("ambiguous");
    expect(result.candidates.map((s: any) => s.symbol_ref.container)).toEqual(["A", "B"]);
    const selected = await tool({ action: "inspect", query: "A.Save", include_source: true });
    expect(selected.symbol).toBe("Save");
    expect(selected.symbol_ref.receiver).toBe("*A");
    expect(selected.source_slice.text).toBe("func (a *A) Save() {}");
  });
  it("locates nested Rust owners and scopes sibling methods", async () => {
    await index("lib.rs", "mod app { mod billing { pub struct Invoice; impl Invoice { pub fn save(&self) {} pub fn own(&self) {} } } pub struct Other; impl Other { pub fn foreign(&self) {} } }");
    const result = await tool({ action: "locate", query: "app::billing::Invoice::save" });
    expect(result.found).toBe(true);
    expect(result.container_name).toBe("app::billing::Invoice");
    expect(result.sibling_methods).toEqual(["own"]);
    expect(result.symbol_ref.language).toBe("rust");
  });
  it("does not choose a class from another domain or a same-file foreign method", async () => {
    await index("a.ts", "export class A { own() {} }\nexport class B { foreign() {} }", "alpha");
    await index("b.ts", "export class A { own() {} }", "beta");
    expect((await tool({ action: "locate", query: "A::own" })).status).toBe("ambiguous");
    expect((await tool({ action: "locate", query: "A::own", domain: "beta" })).file_path).toBe("b.ts");
    expect((await tool({ action: "locate", query: "A::foreign", file_path: "a.ts" })).found).toBe(false);
    expect((await tool({ action: "locate", query: "A::own", file_path: "a.ts", domain: "beta" })).found).toBe(false);
  });
  it("exposes every declaration in a full catalog without losing overloads", async () => {
    await index("Order.java", java);
    const full = repo.getDomainCatalog("core", undefined, { detailLevel: "full" })!;
    const refs = full.files[0]!.declarations!.filter(ref => ref.name === "Order.save");
    expect(refs).toHaveLength(2);
    const selected = await tool({ action: "inspect", symbol_ref: refs[1], include_source: true });
    expect(selected.source_slice.status).toBe("current");
    expect(selected.signature).toContain("String id");
    expect(repo.getDomainCatalog("core")!.files[0]!.declarations).toBeUndefined();
  });
  it("does not treat underscores or percent signs as SQL name wildcards", async () => {
    await index("a.ts", "class A { save_item() {} saveXitem() {} }");
    expect((await tool({ action: "inspect", query: "save_item" })).symbol).toBe("A::save_item");
    expect((await tool({ action: "inspect", query: "save%" })).found).toBe(false);
  });
  it("preserves legacy TS/PHP query aliases and yields round-trippable references", async () => {
    for (const [file, source, query] of [["a.ts", "export class Service { save() {} }", "Service::save"], ["a.php", "<?php class Service { public function save() {} }", "Service::save"]]) {
      await index(file, source);
      const located = await tool({ action: "locate", query, file_path: file });
      expect(located.found).toBe(true);
      const result = await tool({ action: "inspect", name: query, file_path: file, include_source: true });
      expect(result.symbol_ref).toEqual(located.symbol_ref);
      expect(result.source_slice.status).toBe("current");
      expect((await tool({ action: "locate", query: `Call to undefined method Service::save()`, file_path: file })).found).toBe(true);
    }
  });
  it("rejects an old reference after reindex instead of selecting a replacement", async () => {
    await index("a.ts", "export function save() {}\n");
    const original = await tool({ action: "inspect", query: "save" });
    await index("a.ts", "export function save() { return 2; }\n");
    const selected = await tool({ action: "inspect", symbol_ref: original.symbol_ref, include_source: true });
    expect(selected.status).toBe("stale_reference");
    expect(selected.found).toBe(false);
    expect(selected.source_slice.text).toBeUndefined();
  });
  it("keeps references valid across identical reindex without depending on SQLite IDs", async () => {
    await index("a.ts", "export function save() {}");
    const old = await tool({ action: "inspect", query: "save" });
    const id = repo.findSymbolsByName("save")[0]!.id;
    await index("a.ts", "export function save() {}");
    expect(repo.findSymbolsByName("save")[0]!.id).not.toBe(id);
    expect((await tool({ action: "inspect", symbol_ref: old.symbol_ref })).symbol_ref).toEqual(old.symbol_ref);
    expect((await tool({ action: "inspect", symbol_ref: old.symbol_ref, file_path: "elsewhere.ts" })).found).toBe(false);
  });
  it("keeps Ruby singleton and instance selectors distinct", async () => {
    await index("service.rb", "class Service\n  def save; end\n  def self.save; end\nend");
    expect((await tool({ action: "inspect", query: "save" })).status).toBe("ambiguous");
    expect((await tool({ action: "inspect", query: "Service#save" })).symbol).toBe("Service#save");
    expect((await tool({ action: "inspect", query: "Service.save" })).symbol).toBe("Service.save");
    expect((await tool({ action: "locate", query: "Service.save" })).exact_symbol.name).toBe("Service.save");
    expect((await tool({ action: "locate", query: "Service#save" })).exact_symbol.name).toBe("Service#save");
  });
  it("retains ambiguity when identical declarations share every available discriminator", async () => {
    await index("a.ts", "function save() {} function save() {}");
    const result = await tool({ action: "inspect", query: "save", include_source: true });
    expect(result.candidates).toHaveLength(2);
    const selected = await tool({ action: "inspect", symbol_ref: result.candidates[0].symbol_ref, include_source: true });
    expect(selected.status).toBe("ambiguous");
    expect(selected.source_slice.text).toBeUndefined();
  });
  it("rejects invalid reference coordinates and unsupported selector actions", () => {
    expect(SymbolToolSchema.safeParse({ action: "inspect", symbol_ref: { name: "save" } }).success).toBe(false);
    const ref = { name: "save", file_path: "a.ts", language: "typescript", kind: "function", signature: "save()", start_line: 3, end_line: 2, indexed_content_hash: "fixture" };
    expect(SymbolToolSchema.safeParse({ action: "inspect", symbol_ref: ref }).success).toBe(false);
    expect(SymbolToolSchema.safeParse({ action: "impact", symbol_ref: { ...ref, end_line: 3 } }).success).toBe(false);
  });
  it("reads references from an existing v4 database without losing configuration", async () => {
    db.close();
    const dbPath = join(root, "existing.db");
    db = new SeptumDatabase(dbPath); repo = new SeptumRepository(db.raw);
    await index("a.ts", "export function save() {}");
    repo.setMeta("features_json", JSON.stringify({ task: { domain: "core", allowed_touchpoints: ["a.ts"] } }));
    db.close(); db = new SeptumDatabase(dbPath); repo = new SeptumRepository(db.raw);
    expect(db.raw.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(repo.getAllDomains()[0]!.name).toBe("core");
    expect(JSON.parse(repo.getMeta("features_json")!).task.domain).toBe("core");
    const result = await tool({ action: "inspect", query: "save", include_source: true });
    expect(result.symbol_ref.name).toBe("save");
    expect(result.source_slice.status).toBe("current");
  });
  it("preserves Unicode and CRLF source coordinates", async () => {
    const source = '// café 🚀\r\nexport function save() {\r\n  return "日本語";\r\n}\r\n';
    await index("a.ts", source);
    const result = await tool({ action: "inspect", query: "save", include_source: true });
    expect(result.source_slice.start_line).toBe(2);
    expect(result.source_slice.end_line).toBe(4);
    expect(result.source_slice.text).toBe('export function save() {\r\n  return "日本語";\r\n}');
    expect(result.symbol_ref.indexed_content_hash).toBe(computeContentHash(source));
    expect(result.visibility_semantics).toBe("legacy_normalized");
  });
});
