import { describe, expect, it } from "bun:test";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";

const fixtures = [
  ["sample.ts", "export function okay() {}", "function broken( {", "okay"],
  ["sample.js", "export function okay() {}", "function broken( {", "okay"],
  ["sample.php", "<?php\nfunction okay() {}", "function broken( {", "okay"],
  ["sample.py", "def okay():\n    pass", "def broken( :", "okay"],
  ["sample.go", "package sample\nfunc Okay() {}", "func Broken( {", "Okay"],
  ["sample.rs", "pub fn okay() {}", "fn broken( {", "okay"],
  ["Sample.java", "class Okay {}", "class Broken { void broken( {", "Okay"],
  ["Sample.cs", "class Okay {}", "class Broken { void Broken( {", "Okay"],
  ["sample.rb", "class Okay\nend", "def broken(", "Okay"],
] as const;

describe("source parser recovery status", () => {
  const engine = new ASTParserEngine();
  for (const [file, clean, malformed, symbol] of fixtures) {
    it(`distinguishes clean and recovered ASTs in ${file}`, async () => {
      const parsed = await engine.parseFile(file, clean);
      expect(parsed.status).toBe("parsed");
      expect(parsed.symbols.some(s => s.name === symbol)).toBe(true);
      const recovered = await engine.parseFile(file, `${clean}\n${malformed}`);
      expect(recovered.status).toBe("degraded");
      expect(recovered.symbols.some(s => s.name === symbol)).toBe(true);
    });
  }
});
