import { getLanguageCapability } from "../language-capabilities.ts";
import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
import { findBraceBlockEnd } from "../boundary-tracker.ts";
import { calculateAstControlFlowNesting, getNodeHeader, parseSourceWithTreeSitter } from "../wasm-loader.ts";
import type { CodeExtractor } from "./base.ts";
import type Parser from "web-tree-sitter";

const RUST_CONTROL_FLOW_NODES = new Set([
  "if_expression",
  "match_expression",
  "for_expression",
  "while_expression",
  "loop_expression",
]);

const RUST_FUNCTION_BOUNDARY_NODES = new Set([
  "function_item",
  "closure_expression",
]);

export class RustExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return getLanguageCapability(filePath)?.extractor === "rust";
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const astResult = await parseSourceWithTreeSitter("rust", content, (rootNode) =>
      this.extractFromAst(rootNode, filePath, content),
      () => this.extractFallback(filePath, content)
    );
    if (astResult) {
      return astResult;
    }

    return { ...this.extractFallback(filePath, content), status: "degraded" };
  }

  private isExternalUse(target: string): boolean {
    const trimmed = target.trim();
    if (trimmed.startsWith("crate::") || trimmed.startsWith("super::") || trimmed.startsWith("self::")) {
      return false;
    }
    return true;
  }

  private extractFromAst(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    content: string
  ): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];
    const lines = content.split("\n");

    const getVisibility = (node: Parser.SyntaxNode): Visibility => {
      for (const child of node.namedChildren) {
        if (child.type === "visibility_modifier") {
          return "public";
        }
      }
      return "private";
    };

    const processItem = (node: Parser.SyntaxNode, scopeName?: string, isMethod = false, inheritedVisibility?: Visibility): void => {
      const qualify = (name: string) => scopeName ? `${scopeName}::${name}` : name;
      if (node.type === "mod_item") {
        const name = node.childForFieldName("name");
        const body = node.childForFieldName("body");
        if (name && body) {
          for (const child of body.namedChildren) processItem(child, qualify(name.text));
        }
        return;
      }
      if (node.type === "use_declaration") {
        const text = (lines[node.startPosition.row] ?? node.text).trim().replace(/;$/, "");
        const argumentNode = node.namedChildren.find((c) => c.type !== "visibility_modifier");
        const fullUsePath = argumentNode ? argumentNode.text : text.replace(/^pub\s+use\s+|^use\s+/, "");
        const rawImport = fullUsePath.trim();
        const leafSymbol = rawImport.split("::").pop()?.replace(/[{}\s]/g, "") || rawImport;

        dependencies.push({
          target: rawImport,
          statement: text,
          line_number: node.startPosition.row + 1,
          is_external: this.isExternalUse(rawImport),
          imported_symbols: [leafSymbol],
        });
        return;
      }

      if (node.type === "function_item" || node.type === "function_signature_item") {
        const nameNode =
          node.childForFieldName("name") ??
          node.namedChildren.find((c) => c.type === "identifier");
        if (!nameNode) return;

        const fnName = nameNode.text;
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = getNodeHeader(node);
        const nestingDepth = calculateAstControlFlowNesting(
          node,
          RUST_CONTROL_FLOW_NODES,
          RUST_FUNCTION_BOUNDARY_NODES
        );

        symbols.push({
          name: qualify(fnName),
          kind: isMethod ? "method" : "function",
          signature: headerLine || `fn ${fnName}()`,
          visibility: inheritedVisibility ?? getVisibility(node),
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
          nesting_depth: nestingDepth,
        });
        return;
      }

      if (node.type === "struct_item") {
        const nameNode =
          node.childForFieldName("name") ??
          node.namedChildren.find((c) => c.type === "type_identifier");
        if (!nameNode) return;

        const structName = nameNode.text;
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = getNodeHeader(node);

        symbols.push({
          name: qualify(structName),
          kind: "struct",
          signature: headerLine || `struct ${structName}`,
          visibility: getVisibility(node),
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
          nesting_depth: 1,
        });
        return;
      }

      if (node.type === "enum_item") {
        const nameNode =
          node.childForFieldName("name") ??
          node.namedChildren.find((c) => c.type === "type_identifier");
        if (!nameNode) return;

        const enumName = nameNode.text;
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = getNodeHeader(node);

        symbols.push({
          name: qualify(enumName),
          kind: "enum",
          signature: headerLine || `enum ${enumName}`,
          visibility: getVisibility(node),
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
          nesting_depth: 1,
        });
        return;
      }

      if (node.type === "trait_item") {
        const nameNode =
          node.childForFieldName("name") ??
          node.namedChildren.find((c) => c.type === "type_identifier");
        if (!nameNode) return;

        const traitName = nameNode.text;
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = getNodeHeader(node);

        symbols.push({
          name: qualify(traitName),
          kind: "interface",
          signature: headerLine || `trait ${traitName}`,
          visibility: getVisibility(node),
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
          nesting_depth: 1,
        });
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            processItem(child, qualify(traitName), true, getVisibility(node));
          }
        }
        return;
      }

      if (node.type === "impl_item") {
        const typeNode =
          node.childForFieldName("type") ??
          node.namedChildren.find((c) => c.type === "type_identifier" || c.type === "generic_type");
        const implTarget = typeNode ? typeNode.text : undefined;

        const bodyNode =
          node.childForFieldName("body") ??
          node.namedChildren.find((c) => c.type === "declaration_list");
        if (bodyNode) {
          for (const item of bodyNode.namedChildren) {
            processItem(item, implTarget ? qualify(implTarget) : scopeName, true);
          }
        }
        return;
      }
    };

    for (const node of rootNode.namedChildren) {
      processItem(node);
    }

    return { symbols, dependencies };
  }

  private extractFallback(filePath: string, content: string): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      if (!trimmed || trimmed.startsWith("//")) continue;

      const useMatch = /^(?:pub\s+)?use\s+([^;]+);/.exec(trimmed);
      if (useMatch) {
        const target = useMatch[1].trim();
        const leaf = target.split("::").pop()?.replace(/[{}\s]/g, "") || target;
        dependencies.push({
          target,
          statement: trimmed,
          line_number: lineNum,
          is_external: this.isExternalUse(target),
          imported_symbols: [leaf],
        });
        continue;
      }

      const fnMatch = /^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/.exec(trimmed);
      if (fnMatch) {
        const name = fnMatch[1];
        const lineEnd = findBraceBlockEnd(lines, i);
        symbols.push({
          name,
          kind: "function",
          signature: trimmed.replace(/\{$/, "").trim(),
          visibility: trimmed.startsWith("pub") ? "public" : "private",
          line_start: lineNum,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineNum + 1),
          nesting_depth: 1,
        });
        continue;
      }

      const structMatch = /^(?:pub(?:\([^)]+\))?\s+)?struct\s+([a-zA-Z0-9_]+)/.exec(trimmed);
      if (structMatch) {
        const name = structMatch[1];
        const lineEnd = trimmed.endsWith(";") ? lineNum : findBraceBlockEnd(lines, i);
        symbols.push({
          name,
          kind: "struct",
          signature: trimmed.replace(/\{$/, "").trim(),
          visibility: trimmed.startsWith("pub") ? "public" : "private",
          line_start: lineNum,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineNum + 1),
          nesting_depth: 1,
        });
        continue;
      }
    }

    return { symbols, dependencies };
  }
}
