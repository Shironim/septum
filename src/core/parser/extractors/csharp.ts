import { getLanguageCapability } from "../language-capabilities.ts";
import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
import { findBraceBlockEnd } from "../boundary-tracker.ts";
import { calculateAstControlFlowNesting, getNodeHeader, parseSourceWithTreeSitter } from "../wasm-loader.ts";
import type { CodeExtractor } from "./base.ts";
import type Parser from "web-tree-sitter";

const CSHARP_CONTROL_FLOW_NODES = new Set([
  "if_statement",
  "for_statement",
  "foreach_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "switch_expression",
]);

const CSHARP_FUNCTION_BOUNDARY_NODES = new Set([
  "method_declaration",
  "constructor_declaration",
  "local_function_statement",
  "lambda_expression",
]);

export class CSharpExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return getLanguageCapability(filePath)?.extractor === "csharp";
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const astResult = await parseSourceWithTreeSitter("c_sharp", content, (rootNode) =>
      this.extractFromAst(rootNode, filePath, content),
      () => this.extractFallback(filePath, content)
    );
    if (astResult) {
      return astResult;
    }

    return { ...this.extractFallback(filePath, content), status: "degraded" };
  }

  private isExternalUsing(target: string): boolean {
    const trimmed = target.trim();
    if (trimmed.startsWith("System.") || trimmed.startsWith("Microsoft.")) {
      return true;
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
        if (child.type === "modifier") {
          const modText = child.text;
          if (modText === "public") return "public";
          if (modText === "protected") return "protected";
          if (modText === "private") return "private";
          if (modText === "internal") return "public";
        }
      }
      return "private";
    };

    const processTypeBody = (bodyNode: Parser.SyntaxNode, typeName: string): void => {
      for (const member of bodyNode.namedChildren) {
        if (member.type === "method_declaration" || member.type === "constructor_declaration") {
          const nameNode =
            member.childForFieldName("name") ??
            member.namedChildren.find((c) => c.type === "identifier");
          if (!nameNode) continue;

          const methodName = nameNode.text;
          const lineStart = member.startPosition.row + 1;
          const lineEnd = Math.max(lineStart, member.endPosition.row + 1);
          const headerLine = getNodeHeader(member);
          const nestingDepth = calculateAstControlFlowNesting(
            member,
            CSHARP_CONTROL_FLOW_NODES,
            CSHARP_FUNCTION_BOUNDARY_NODES
          );

          symbols.push({
            name: `${typeName}.${methodName}`,
            kind: "method",
            signature: headerLine || `${methodName}()`,
            visibility: getVisibility(member),
            line_start: lineStart,
            line_end: lineEnd,
            line_count: Math.max(1, lineEnd - lineStart + 1),
            nesting_depth: nestingDepth,
          });
        } else if (
          member.type === "class_declaration" ||
          member.type === "interface_declaration" ||
          member.type === "struct_declaration" ||
          member.type === "record_declaration"
        ) {
          processNode(member, typeName);
        }
      }
    };

    const processNode = (node: Parser.SyntaxNode, parentScope?: string): void => {
      if (node.type === "using_directive") {
        const pathNode = node.namedChildren.find(
          (c) => c.type === "qualified_name" || c.type === "identifier"
        );
        const rawUsing = pathNode
          ? pathNode.text
          : (lines[node.startPosition.row] ?? "").replace(/^using\s+|;$/g, "").trim();
        const leafSymbol = rawUsing.split(".").pop() || rawUsing;

        dependencies.push({
          target: rawUsing,
          statement: (lines[node.startPosition.row] ?? node.text).trim().replace(/;$/, ""),
          line_number: node.startPosition.row + 1,
          is_external: this.isExternalUsing(rawUsing),
          imported_symbols: [leafSymbol],
        });
        return;
      }

      if (
        node.type === "namespace_declaration" ||
        node.type === "file_scoped_namespace_declaration"
      ) {
        const body =
          node.childForFieldName("body") ??
          node.namedChildren.find((c) => c.type === "declaration_list") ??
          node;
        for (const child of body.namedChildren) {
          processNode(child, parentScope);
        }
        return;
      }

      if (
        node.type === "class_declaration" ||
        node.type === "interface_declaration" ||
        node.type === "struct_declaration" ||
        node.type === "record_declaration" ||
        node.type === "enum_declaration"
      ) {
        const nameNode =
          node.childForFieldName("name") ??
          node.namedChildren.find((c) => c.type === "identifier");
        if (!nameNode) return;

        const baseName = nameNode.text;
        const fullName = parentScope ? `${parentScope}.${baseName}` : baseName;
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = getNodeHeader(node);
        const kind =
          node.type === "interface_declaration"
            ? "interface"
            : node.type === "struct_declaration"
            ? "struct"
            : node.type === "enum_declaration"
            ? "enum"
            : "class";

        symbols.push({
          name: fullName,
          kind,
          signature: headerLine || `${kind} ${fullName}`,
          visibility: getVisibility(node),
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
          nesting_depth: 1,
        });

        const bodyNode =
          node.childForFieldName("body") ??
          node.namedChildren.find((c) => c.type === "declaration_list");
        if (bodyNode) {
          processTypeBody(bodyNode, fullName);
        }
      }
    };

    for (const node of rootNode.namedChildren) {
      processNode(node);
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

      const usingMatch = /^using\s+(?:static\s+)?([^;]+);/.exec(trimmed);
      if (usingMatch) {
        const target = usingMatch[1].trim();
        const leaf = target.split(".").pop() || target;
        dependencies.push({
          target,
          statement: trimmed,
          line_number: lineNum,
          is_external: this.isExternalUsing(target),
          imported_symbols: [leaf],
        });
        continue;
      }

      const classMatch = /^(?:(?:public|protected|private|internal|static|abstract|sealed|partial)\s+)*(?:class|interface|struct|record|enum)\s+([a-zA-Z0-9_]+)/.exec(trimmed);
      if (classMatch) {
        const name = classMatch[1];
        const lineEnd = findBraceBlockEnd(lines, i);
        symbols.push({
          name,
          kind: trimmed.includes("interface") ? "interface" : trimmed.includes("struct") ? "struct" : trimmed.includes("enum") ? "enum" : "class",
          signature: trimmed.replace(/\{$/, "").trim(),
          visibility: trimmed.startsWith("public") || trimmed.startsWith("internal") ? "public" : "private",
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
