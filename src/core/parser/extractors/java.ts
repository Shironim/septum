import { getLanguageCapability } from "../language-capabilities.ts";
import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
import { findBraceBlockEnd } from "../boundary-tracker.ts";
import { calculateAstControlFlowNesting, getNodeHeader, parseSourceWithTreeSitter } from "../wasm-loader.ts";
import type { CodeExtractor } from "./base.ts";
import type Parser from "web-tree-sitter";

const JAVA_CONTROL_FLOW_NODES = new Set([
  "if_statement",
  "for_statement",
  "enhanced_for_statement",
  "while_statement",
  "do_statement",
  "switch_expression",
  "switch_statement",
]);

const JAVA_FUNCTION_BOUNDARY_NODES = new Set([
  "method_declaration",
  "constructor_declaration",
  "lambda_expression",
]);

export class JavaExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return getLanguageCapability(filePath)?.extractor === "java";
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const astResult = await parseSourceWithTreeSitter("java", content, (rootNode) =>
      this.extractFromAst(rootNode, filePath, content),
      () => this.extractFallback(filePath, content)
    );
    if (astResult) {
      return astResult;
    }

    return { ...this.extractFallback(filePath, content), status: "degraded" };
  }

  private isExternalImport(importTarget: string): boolean {
    const trimmed = importTarget.trim();
    if (trimmed.startsWith("java.") || trimmed.startsWith("javax.")) {
      return true;
    }
    return true; // Unless configured otherwise, Java imports are typically external or package-scoped
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
      const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
      if (modifiers) {
        const text = modifiers.text;
        if (/\bpublic\b/.test(text)) return "public";
        if (/\bprotected\b/.test(text)) return "protected";
        if (/\bprivate\b/.test(text)) return "private";
      }
      return "private";
    };

    const processClassBody = (bodyNode: Parser.SyntaxNode, className: string): void => {
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
            JAVA_CONTROL_FLOW_NODES,
            JAVA_FUNCTION_BOUNDARY_NODES
          );

          symbols.push({
            name: `${className}.${methodName}`,
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
          member.type === "enum_declaration"
        ) {
          processTopLevel(member, className);
        }
      }
    };

    const processTopLevel = (node: Parser.SyntaxNode, parentName?: string): void => {
      if (node.type === "import_declaration") {
        const pathNode = node.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier");
        const rawImport = pathNode ? pathNode.text : (lines[node.startPosition.row] ?? "").replace(/^import\s+|;$/g, "").trim();
        const leafSymbol = rawImport.split(".").pop() || rawImport;

        dependencies.push({
          target: rawImport,
          statement: (lines[node.startPosition.row] ?? node.text).trim().replace(/;$/, ""),
          line_number: node.startPosition.row + 1,
          is_external: this.isExternalImport(rawImport),
          imported_symbols: [leafSymbol],
        });
        return;
      }

      if (
        node.type === "class_declaration" ||
        node.type === "interface_declaration" ||
        node.type === "enum_declaration" ||
        node.type === "record_declaration"
      ) {
        const nameNode =
          node.childForFieldName("name") ??
          node.namedChildren.find((c) => c.type === "identifier");
        if (!nameNode) return;

        const baseName = nameNode.text;
        const fullName = parentName ? `${parentName}.${baseName}` : baseName;
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = getNodeHeader(node);
        const kind =
          node.type === "interface_declaration"
            ? "interface"
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
          node.namedChildren.find(
            (c) =>
              c.type === "class_body" ||
              c.type === "interface_body" ||
              c.type === "enum_body" ||
              c.type === "record_body"
          );
        if (bodyNode) {
          processClassBody(bodyNode, fullName);
        }
      }
    };

    for (const node of rootNode.namedChildren) {
      processTopLevel(node);
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

      const importMatch = /^import\s+(?:static\s+)?([^;]+);/.exec(trimmed);
      if (importMatch) {
        const target = importMatch[1].trim();
        const leaf = target.split(".").pop() || target;
        dependencies.push({
          target,
          statement: trimmed,
          line_number: lineNum,
          is_external: this.isExternalImport(target),
          imported_symbols: [leaf],
        });
        continue;
      }

      const classMatch = /^(?:(?:public|protected|private|static|final|abstract)\s+)*(?:class|interface|enum|record)\s+([a-zA-Z0-9_]+)/.exec(trimmed);
      if (classMatch) {
        const name = classMatch[1];
        const lineEnd = findBraceBlockEnd(lines, i);
        symbols.push({
          name,
          kind: trimmed.includes("interface") ? "interface" : trimmed.includes("enum") ? "enum" : "class",
          signature: trimmed.replace(/\{$/, "").trim(),
          visibility: trimmed.startsWith("public") ? "public" : trimmed.startsWith("protected") ? "protected" : "private",
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
