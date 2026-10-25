import runtime from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import typescript from "tree-sitter-wasms/out/tree-sitter-typescript.wasm" with { type: "file" };
import tsx from "tree-sitter-wasms/out/tree-sitter-tsx.wasm" with { type: "file" };
import javascript from "tree-sitter-wasms/out/tree-sitter-javascript.wasm" with { type: "file" };
import php from "tree-sitter-wasms/out/tree-sitter-php.wasm" with { type: "file" };
import python from "tree-sitter-wasms/out/tree-sitter-python.wasm" with { type: "file" };
import go from "tree-sitter-wasms/out/tree-sitter-go.wasm" with { type: "file" };
import rust from "tree-sitter-wasms/out/tree-sitter-rust.wasm" with { type: "file" };
import java from "tree-sitter-wasms/out/tree-sitter-java.wasm" with { type: "file" };
import csharp from "tree-sitter-wasms/out/tree-sitter-c_sharp.wasm" with { type: "file" };
import ruby from "tree-sitter-wasms/out/tree-sitter-ruby.wasm" with { type: "file" };

export const WASM_ASSETS: Record<string, string> = {
  "tree-sitter.wasm": runtime,
  "tree-sitter-typescript.wasm": typescript,
  "tree-sitter-tsx.wasm": tsx,
  "tree-sitter-javascript.wasm": javascript,
  "tree-sitter-php.wasm": php,
  "tree-sitter-python.wasm": python,
  "tree-sitter-go.wasm": go,
  "tree-sitter-rust.wasm": rust,
  "tree-sitter-java.wasm": java,
  "tree-sitter-c_sharp.wasm": csharp,
  "tree-sitter-ruby.wasm": ruby,
};
