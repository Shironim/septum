import type Parser from "web-tree-sitter";
import type {
  ExtractedDependency,
  ExtractedSymbol,
  ParsedFileAST,
  SymbolKind,
  Visibility,
} from "../../../types/index.ts";
import {
  blankCommentsAndStrings,
  calculateControlFlowNesting,
  findBraceBlockEnd,
} from "../boundary-tracker.ts";
import { calculateAstControlFlowNesting, parseWithTreeSitter } from "../wasm-loader.ts";
import type { CodeExtractor } from "./base.ts";

const PHP_CONTROL_FLOW_NODES = new Set([
  "if_statement",
  "for_statement",
  "foreach_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "try_statement",
  "catch_clause",
  "match_expression",
  "conditional_expression",
]);

const PHP_FUNCTION_BOUNDARY_NODES = new Set([
  "function_definition",
  "method_declaration",
  "anonymous_function_creation_expression",
  "arrow_function",
]);

export class PHPExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return /\.php$/i.test(filePath);
  }

  public async extract(_filePath: string, content: string): Promise<ParsedFileAST> {
    const astResult = await parseWithTreeSitter("php", content, (rootNode) =>
      this.extractFromAst(rootNode, content)
    );
    if (astResult) {
      return { ...astResult, status: "parsed" };
    }

    return { ...this.extractFallback(content), status: "degraded" };
  }

  private isExternalNamespace(cleaned: string): boolean {
    return (
      cleaned.startsWith("Illuminate\\") ||
      cleaned.startsWith("Symfony\\") ||
      cleaned.startsWith("Psr\\") ||
      cleaned.startsWith("Composer\\")
    );
  }

  private extractFallback(content: string): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const lines = content.split("\n");
    const cleanLines = blankCommentsAndStrings(content, { hashComments: true }).split("\n");

    // 1. Extract PHP use / import statements
    const useRegex = /^\s*use\s+([^;]+);/;
    for (let i = 0; i < lines.length; i++) {
      if (!cleanLines[i]?.trim()) continue;
      const line = lines[i];
      const match = useRegex.exec(cleanLines[i]);
      if (match) {
        const fullTarget = match[1].trim();
        const cleaned = fullTarget.replace(/^(function|const)\s+/, "").replace(/\s+as\s+[A-Za-z0-9_]+$/i, "").trim();
        const aliasMatch = /\bas\s+([A-Za-z0-9_]+)$/i.exec(fullTarget);
        const shortName = cleaned.split("\\").pop() || cleaned;
        const importedSymbols = Array.from(new Set([shortName, ...(aliasMatch ? [aliasMatch[1]] : [])])).filter(Boolean);

        dependencies.push({
          target: cleaned,
          statement: line.trim(),
          line_number: i + 1,
          is_external: this.isExternalNamespace(cleaned),
          ...(importedSymbols.length > 0 ? { imported_symbols: importedSymbols } : {}),
        });
      }
    }


    // 2. Extract PHP Class / Interface / Trait / Enum
    let currentContainer: string | null = null;
    let currentContainerEndLine = 0;

    for (let i = 0; i < cleanLines.length; i++) {
      const trimmed = cleanLines[i].trim();
      const rawTrimmed = lines[i].trim();
      const lineNum = i + 1;

      if (!trimmed) continue;

      if (currentContainer && lineNum > currentContainerEndLine) {
        currentContainer = null;
        currentContainerEndLine = 0;
      }

      const classMatch = /^(?:abstract\s+|final\s+|readonly\s+)*\b(class|interface|trait|enum)\s+([A-Za-z0-9_]+)\b/.exec(
        trimmed
      );
      if (classMatch) {
        currentContainer = classMatch[2];
        const endLine = findBraceBlockEnd(cleanLines, i);
        currentContainerEndLine = endLine;
        symbols.push({
          name: classMatch[2],
          kind: classMatch[1] as SymbolKind,
          signature: rawTrimmed.replace(/\{$/, "").trim(),
          visibility: "public",
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
        continue;
      }

      if (currentContainer) {
        const constMatch = /^(?:(public|protected|private)\s+)?\bconst\s+([A-Za-z0-9_]+)\s*=/.exec(trimmed);
        if (constMatch) {
          const vis = (constMatch[1] as Visibility) || "public";
          const constName = constMatch[2];
          symbols.push({
            name: `${currentContainer}::${constName}`,
            kind: "property",
            signature: `${vis} const ${constName}`,
            visibility: vis,
            line_start: lineNum,
            line_end: lineNum,
            line_count: 1,
          });
          continue;
        }

        const propMatch =
          /^(?:(public|protected|private)\s+)?(?:readonly\s+)?(?:static\s+)?(?:\??[A-Za-z0-9_\\]+\s+)?\$([A-Za-z0-9_]+)(?:\s*=[^;]+)?;\s*$/.exec(
            trimmed
          );
        if (propMatch && !trimmed.includes("function ")) {
          const vis = (propMatch[1] as Visibility) || "public";
          const propName = `$${propMatch[2]}`;
          symbols.push({
            name: `${currentContainer}::${propName}`,
            kind: "property",
            signature: `${vis} ${rawTrimmed.replace(/;\s*$/, "")}`,
            visibility: vis,
            line_start: lineNum,
            line_end: lineNum,
            line_count: 1,
          });
          continue;
        }

        const methodMatch =
          /^(?:(public|protected|private)\s+)?(?:static\s+)?(?:final\s+)?\bfunction\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/.exec(
            trimmed
          );
        if (methodMatch) {
          const vis = (methodMatch[1] as Visibility) || "public";
          const name = methodMatch[2];
          const params = methodMatch[3].trim();
          const retType = methodMatch[4] ? `: ${methodMatch[4].trim()}` : "";
          const endLine = findBraceBlockEnd(cleanLines, i);
          const nestingDepth = calculateControlFlowNesting(lines, i, endLine - 1);
          symbols.push({
            name: `${currentContainer}::${name}`,
            kind: "method",
            signature: `${vis} function ${name}(${params})${retType}`,
            visibility: vis,
            line_start: lineNum,
            line_end: endLine,
            line_count: Math.max(1, endLine - lineNum + 1),
            nesting_depth: nestingDepth,
          });
          continue;
        }
      }

      const funcMatch = /^(?:final\s+)?\bfunction\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/.exec(trimmed);
      if (funcMatch && !currentContainer) {
        const name = funcMatch[1];
        const params = funcMatch[2].trim();
        const retType = funcMatch[3] ? `: ${funcMatch[3].trim()}` : "";
        const endLine = findBraceBlockEnd(cleanLines, i);
        const nestingDepth = calculateControlFlowNesting(lines, i, endLine - 1);
        symbols.push({
          name,
          kind: "function",
          signature: `function ${name}(${params})${retType}`,
          visibility: "public",
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
          nesting_depth: nestingDepth,
        });
      }
    }

    return { symbols, dependencies };
  }

  private extractFromAst(rootNode: Parser.SyntaxNode, content: string): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];
    const lines = content.split("\n");

    const walk = (node: Parser.SyntaxNode): void => {
      if (node.type === "namespace_use_declaration") {
        const rawStmt = (lines[node.startPosition.row] ?? node.text).trim();
        const bodyMatch = /^\s*use\s+([^;]+);/i.exec(node.text.replace(/\r?\n/g, " "));
        if (bodyMatch) {
          const fullTarget = bodyMatch[1].trim();
          const cleaned = fullTarget.replace(/^(function|const)\s+/i, "").replace(/\s+as\s+[A-Za-z0-9_]+$/i, "").trim();
          const aliasMatch = /\bas\s+([A-Za-z0-9_]+)$/i.exec(fullTarget);
          const shortName = cleaned.split("\\").pop() || cleaned;
          const importedSymbols = Array.from(
            new Set([shortName, ...(aliasMatch ? [aliasMatch[1]] : [])])
          ).filter(Boolean);

          dependencies.push({
            target: cleaned,
            statement: rawStmt,
            line_number: node.startPosition.row + 1,
            is_external: this.isExternalNamespace(cleaned),
            ...(importedSymbols.length > 0 ? { imported_symbols: importedSymbols } : {}),
          });
        }
        return;
      }

      if (
        node.type === "class_declaration" ||
        node.type === "interface_declaration" ||
        node.type === "trait_declaration" ||
        node.type === "enum_declaration"
      ) {
        const nameNode = node.childForFieldName("name") ?? node.namedChildren.find((c) => c.type === "name");
        if (!nameNode) return;

        const containerName = nameNode.text;
        const kindMap: Record<string, SymbolKind> = {
          class_declaration: "class",
          interface_declaration: "interface",
          trait_declaration: "trait",
          enum_declaration: "enum",
        };
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = (lines[node.startPosition.row] ?? "").trim().replace(/\{$/, "").trim();

        symbols.push({
          name: containerName,
          kind: kindMap[node.type] ?? "class",
          signature: headerLine || `${kindMap[node.type]} ${containerName}`,
          visibility: "public",
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
        });

        const bodyNode =
          node.childForFieldName("body") ?? node.namedChildren.find((c) => c.type === "declaration_list" || c.type === "enum_declaration_list");
        if (bodyNode) {
          this.extractPhpContainerMembers(containerName, bodyNode, lines, symbols);
        }
        return;
      }

      if (node.type === "function_definition") {
        const nameNode = node.childForFieldName("name") ?? node.namedChildren.find((c) => c.type === "name");
        if (!nameNode) return;

        const fnName = nameNode.text;
        const paramsNode = node.childForFieldName("parameters") ?? node.namedChildren.find((c) => c.type === "formal_parameters");
        const retNode = node.childForFieldName("return_type");
        const paramsText = paramsNode ? paramsNode.text : "()";
        const retText = retNode ? `: ${retNode.text.replace(/^:\s*/, "")}` : "";
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const nestingDepth = calculateAstControlFlowNesting(
          node,
          PHP_CONTROL_FLOW_NODES,
          PHP_FUNCTION_BOUNDARY_NODES
        );

        symbols.push({
          name: fnName,
          kind: "function",
          signature: `function ${fnName}${paramsText}${retText}`,
          visibility: "public",
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
          nesting_depth: nestingDepth,
        });
        return;
      }

      for (const child of node.namedChildren) {
        walk(child);
      }
    };

    walk(rootNode);
    return { symbols, dependencies };
  }

  private extractPhpContainerMembers(
    containerName: string,
    bodyNode: Parser.SyntaxNode,
    lines: string[],
    symbols: ExtractedSymbol[]
  ): void {
    for (const member of bodyNode.namedChildren) {
      const mStart = member.startPosition.row + 1;
      const mEnd = Math.max(mStart, member.endPosition.row + 1);
      const mCount = Math.max(1, mEnd - mStart + 1);
      const vis = this.extractPhpVisibility(member);

      if (member.type === "method_declaration") {
        const nameNode = member.childForFieldName("name") ?? member.namedChildren.find((c) => c.type === "name");
        if (!nameNode) continue;

        const methodName = nameNode.text;
        const paramsNode =
          member.childForFieldName("parameters") ??
          member.namedChildren.find((c) => c.type === "formal_parameters");
        const retNode = member.childForFieldName("return_type");
        const paramsText = paramsNode ? paramsNode.text : "()";
        const retText = retNode ? `: ${retNode.text.replace(/^:\s*/, "")}` : "";
        const nestingDepth = calculateAstControlFlowNesting(
          member,
          PHP_CONTROL_FLOW_NODES,
          PHP_FUNCTION_BOUNDARY_NODES
        );

        symbols.push({
          name: `${containerName}::${methodName}`,
          kind: "method",
          signature: `${vis} function ${methodName}${paramsText}${retText}`,
          visibility: vis,
          line_start: mStart,
          line_end: mEnd,
          line_count: mCount,
          nesting_depth: nestingDepth,
        });
        continue;
      }

      if (member.type === "property_declaration") {
        const propElem = member.namedChildren.find((c) => c.type === "property_element");
        const varNode =
          propElem?.namedChildren.find((c) => c.type === "variable_name") ??
          member.namedChildren.find((c) => c.type === "variable_name");
        if (!varNode) continue;

        const propName = varNode.text.startsWith("$") ? varNode.text : `$${varNode.text}`;
        const rawLine = (lines[member.startPosition.row] ?? member.text).trim().replace(/;\s*$/, "");

        symbols.push({
          name: `${containerName}::${propName}`,
          kind: "property",
          signature: rawLine.startsWith(vis) ? rawLine : `${vis} ${rawLine}`,
          visibility: vis,
          line_start: mStart,
          line_end: mEnd,
          line_count: mCount,
        });
        continue;
      }

      if (member.type === "const_declaration") {
        const constElem = member.namedChildren.find((c) => c.type === "const_element");
        const nameNode =
          constElem?.namedChildren.find((c) => c.type === "name") ??
          member.namedChildren.find((c) => c.type === "name");
        if (!nameNode) continue;

        const constName = nameNode.text;
        symbols.push({
          name: `${containerName}::${constName}`,
          kind: "property",
          signature: `${vis} const ${constName}`,
          visibility: vis,
          line_start: mStart,
          line_end: mEnd,
          line_count: mCount,
        });
      }
    }
  }

  private extractPhpVisibility(node: Parser.SyntaxNode): Visibility {
    for (const child of node.children) {
      if (child.type === "visibility_modifier") {
        const t = child.text.trim().toLowerCase();
        if (t === "private" || t === "protected" || t === "public") {
          return t;
        }
      }
    }
    return "public";
  }
}

