import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";

describe("Rust symbol inspection metadata", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;

  beforeEach(async () => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    const domain = repo.upsertDomain("billing", { root: "src" });
    const file = repo.upsertFile(domain, "src/lib.rs", "model", "fixture", 1);
    const ast = await new ASTParserEngine().parseFile("src/lib.rs", `mod billing {
    pub struct Invoice;
    pub struct InvoiceExtra;
    pub trait Billable {
        fn bill(&self, amount: u64) -> bool;
        fn ready(&self) -> bool { true }
    }
    impl Invoice {
        pub fn total(&self, amount: u64) -> u64 { amount }
        pub fn submit(&self, service: &PaymentService) {}
    }
    impl InvoiceExtra { pub fn unrelated(&self) {} }
    pub fn standalone(amount: u64) {}
    mod nested {
        pub struct Invoice;
        impl Invoice { pub fn nested_only(&self) {} }
    }
}
pub enum Status { Pending }
impl Status { pub fn label(&self) {} }
pub struct Order_Item;
impl Order_Item { pub fn own(&self) {} }
pub struct OrderXItem;
impl OrderXItem { pub fn foreign(&self) {} }
`);
    expect(ast.status).toBe("parsed");
    repo.replaceFileSymbols(file, ast.symbols);
  });
  afterEach(() => db.close());

  async function inspect(query: string, includeDependencies = true) {
    const result = await handleSymbolTool(repo, ConfigLoader.getDefaultConfig(), {
      action: "inspect", query, file_path: "src/lib.rs", include_dependencies: includeDependencies,
    });
    return JSON.parse(result.content[0].text);
  }

  it("lists only methods owned by the selected scoped struct", async () => {
    const result = await inspect("billing::Invoice");
    expect(result.sibling_methods).toEqual(["total", "submit"]);
  });

  it("uses the immediate owner of a Rust method and excludes the method itself", async () => {
    const result = await inspect("billing::Invoice::total");
    expect(result.sibling_methods).toEqual(["submit"]);
  });

  it("keeps trait methods separate from impl methods", async () => {
    expect((await inspect("billing::Billable")).sibling_methods).toEqual(["bill", "ready"]);
    expect((await inspect("billing::Billable::bill")).sibling_methods).toEqual(["ready"]);
  });

  it("supports nested modules and top-level enum impls", async () => {
    expect((await inspect("billing::nested::Invoice")).sibling_methods).toEqual(["nested_only"]);
    expect((await inspect("Status")).sibling_methods).toEqual(["label"]);
    expect((await inspect("billing::standalone")).sibling_methods).toBeUndefined();
  });

  it("does not interpret underscores in type names as SQL wildcards", async () => {
    expect((await inspect("Order_Item")).sibling_methods).toEqual(["own"]);
  });

  it("does not label Rust values or borrowed services as injected dependencies", async () => {
    for (const query of ["billing::Billable::bill", "billing::Invoice::total", "billing::Invoice::submit", "billing::standalone"]) {
      expect((await inspect(query)).dependencies_injected).toEqual([]);
    }
    expect((await inspect("billing::Invoice::total", false)).dependencies_injected).toEqual([]);
  });
});
