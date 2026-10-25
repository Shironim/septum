import { describe, expect, it } from "bun:test";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";

describe("multilanguage structural depth", () => {
  const engine = new ASTParserEngine();

  it("preserves scopes and trait methods inside Rust inline modules", async () => {
    const result = await engine.parseFile("lib.rs", `mod billing {
    pub struct Invoice;
    pub fn charge() {}
    pub trait Billable {
        fn bill(&self, amount: u64) -> bool;
        fn ready(&self) -> bool { true }
    }
    impl Invoice { pub fn total(&self) -> u64 { 1 } }
}`);
    expect(result.status).toBe("parsed");
    expect(result.symbols.find(s => s.name === "billing::Invoice")?.kind).toBe("struct");
    expect(result.symbols.find(s => s.name === "billing::charge")?.kind).toBe("function");
    expect(result.symbols.find(s => s.name === "billing::Billable::bill")?.signature).toContain("amount: u64");
    expect(result.symbols.find(s => s.name === "billing::Billable::ready")?.visibility).toBe("public");
    expect(result.symbols.find(s => s.name === "billing::Invoice::total")?.kind).toBe("method");
  });

  it("extracts Ruby visibility-wrapped methods without changing following visibility", async () => {
    const result = await engine.parseFile("order.rb", `class Order
  private def save(id)
    id
  end
  def call
  end
end`);
    expect(result.status).toBe("parsed");
    expect(result.symbols.find(s => s.name === "Order#save")?.visibility).toBe("private");
    expect(result.symbols.find(s => s.name === "Order#call")?.visibility).toBe("public");
  });

  const signatures = [
    ["a.ts", "export class A\n extends Base\n implements Contract {\n save() {}\n}", "A", "extends Base", "implements Contract"],
    ["a.php", "<?php\nclass A\n extends Base\n implements Contract {\n public function save() {}\n}", "A", "extends Base", "implements Contract"],
    ["A.java", "class A {\n public int save(\n String id,\n int count\n ) { return count; }\n}", "A.save", "String id", "int count"],
    ["A.cs", "class A {\n public int Save(\n string id,\n int count\n ) { return count; }\n}", "A.Save", "string id", "int count"],
    ["a.py", "def save(\n    name: str,\n    count: int\n) -> int:\n    return count", "save", "name: str", "-> int"],
    ["a.go", "package a\nfunc Save(\n name string,\n count int,\n) int { return count }", "Save", "name string", ") int"],
    ["a.rs", "pub fn save(\n name: &str,\n count: u64,\n) -> u64 { count }", "save", "name: &str", "-> u64"],
    ["a.rb", "def save(\n name,\n count\n)\n count\nend", "save", "name", "count"],
  ] as const;
  for (const [file, code, name, parameter, returnOrParameter] of signatures) {
    it(`retains complete multiline signature in ${file}`, async () => {
      const result = await engine.parseFile(file, code);
      expect(result.status).toBe("parsed");
      const signature = result.symbols.find(s => s.name === name)?.signature;
      expect(signature).toContain(parameter);
      expect(signature).toContain(returnOrParameter);
      expect(signature).not.toContain("return count");
    });
  }
});
