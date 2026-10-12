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

const TS_CONTROL_FLOW_NODES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "try_statement",
  "catch_clause",
  "ternary_expression",
]);

const TS_FUNCTION_BOUNDARY_NODES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
]);

export class TypeScriptExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(filePath);
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const langKey = this.resolveLanguageKey(filePath);
    const treeSitterResult = await parseWithTreeSitter(langKey, content, (rootNode) =>
      this.extractFromAst(rootNode, content)
    );

    if (treeSitterResult) {
      return { ...treeSitterResult, status: "parsed" };
    }

    return { ...this.extractFallback(content), status: "degraded" };
  }

  private resolveLanguageKey(filePath: string): string {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".tsx")) return "tsx";
    if (/\.(js|jsx|mjs|cjs)$/.test(lower)) return "javascript";
    return "typescript";
  }

  private extractFallback(content: string): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const rawLines = content.split("\n");
    const cleanContent = blankCommentsAndStrings(content);
    const cleanLines = cleanContent.split("\n");

    const importRegex =
      /^\s*(?:import\s+(?:type\s+)?(?:([\w*\s{},]+)\s+from\s+)?['"]([^'"]+)['"]|(?:const|let|var)\s+([\w\s{},:$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/;

    for (let i = 0; i < rawLines.length; i++) {
      if (!cleanLines[i]?.trim()) continue;
      const line = rawLines[i];
      const match = importRegex.exec(line);
      if (match) {
        const target = match[2] || match[4] || match[5];
        const clause = match[1] || match[3] || "";
        if (target) {
          const importedSymbols = clause
            .replace(/[{}*]/g, " ")
            .split(/,|\bas\b/)
            .map((s) => s.trim())
            .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) && s !== "type");
          const isExternal = !target.startsWith(".") && !target.startsWith("/");
          dependencies.push({
            target,
            statement: line.trim(),
            line_number: i + 1,
            is_external: isExternal,
            ...(importedSymbols.length > 0 ? { imported_symbols: Array.from(new Set(importedSymbols)) } : {}),
          });
        }
      }
    }

    // 2. Extract Symbols using cleanLines + brace depth tracking
    let currentClass: string | null = null;
    let currentClassDepth = 0;
    let braceDepth = 0;

    for (let i = 0; i < cleanLines.length; i++) {
      const cleanTrimmed = cleanLines[i].trim();
      const rawTrimmed = rawLines[i].trim();
      const lineNum = i + 1;

      if (currentClass && braceDepth < currentClassDepth) {
        currentClass = null;
        currentClassDepth = 0;
      }

      if (cleanTrimmed && braceDepth === 0) {
        const classMatch =
          /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?\b(class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(
            cleanTrimmed
          );
        if (classMatch) {
          currentClass = classMatch[2];
          currentClassDepth = braceDepth + 1;
          const endLine = findBraceBlockEnd(cleanLines, i);
          symbols.push({
            name: classMatch[2],
            kind: classMatch[1] as "class" | "interface",
            signature: rawTrimmed.replace(/\{$/, "").trim(),
            visibility: "public",
            line_start: lineNum,
            line_end: endLine,
            line_count: Math.max(1, endLine - lineNum + 1),
          });
        } else {
          const typeMatch = /^(?:export\s+)?\btype\s+([A-Za-z_$][A-Za-z0-9_$]*)\b\s*=/.exec(cleanTrimmed);
          if (typeMatch) {
            const endLine = cleanTrimmed.endsWith(";") ? lineNum : findBraceBlockEnd(cleanLines, i);
            symbols.push({
              name: typeMatch[1],
              kind: "type",
              signature: rawTrimmed.replace(/;$/, "").trim(),
              visibility: "public",
              line_start: lineNum,
              line_end: endLine,
              line_count: Math.max(1, endLine - lineNum + 1),
            });
          }

          const enumMatch = /^(?:export\s+)?(?:const\s+)?\benum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(cleanTrimmed);
          if (enumMatch) {
            const endLine = findBraceBlockEnd(cleanLines, i);
            symbols.push({
              name: enumMatch[1],
              kind: "enum",
              signature: rawTrimmed.replace(/\{$/, "").trim(),
              visibility: "public",
              line_start: lineNum,
              line_end: endLine,
              line_count: Math.max(1, endLine - lineNum + 1),
            });
          }

          const fnMatch =
            /^(?:export\s+)?(?:default\s+)?(?:async\s+)?\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/.exec(
              cleanTrimmed
            );
          if (fnMatch) {
            const name = fnMatch[1];
            const params = fnMatch[2];
            const retType = fnMatch[3] ? `: ${fnMatch[3].trim()}` : "";
            const endLine = findBraceBlockEnd(cleanLines, i);
            const nestingDepth = calculateControlFlowNesting(rawLines, i, endLine - 1);
            symbols.push({
              name,
              kind: "function",
              signature: `${name}(${params})${retType}`,
              visibility: "public",
              line_start: lineNum,
              line_end: endLine,
              line_count: Math.max(1, endLine - lineNum + 1),
              nesting_depth: nestingDepth,
            });
          }

          const varMatch =
            /^(?:export\s+)?\b(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*([^=;]+))?\s*=\s*(.*)$/.exec(
              cleanTrimmed
            );
          if (varMatch) {
            const declKind = varMatch[1];
            const varName = varMatch[2];
            const typeStr = varMatch[3] ? `: ${varMatch[3].trim()}` : "";
            const rhs = varMatch[4].trim();
            const isArrowOrFn = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|^function\b/.test(rhs);
            symbols.push({
              name: varName,
              kind: isArrowOrFn ? "function" : declKind === "const" ? "constant" : "variable",
              signature: `${declKind} ${varName}${typeStr}`,
              visibility: cleanTrimmed.startsWith("export ") ? "public" : "private",
              line_start: lineNum,
              line_end: lineNum,
              line_count: 1,
            });
          }
        }
      } else if (cleanTrimmed && currentClass && braceDepth === currentClassDepth) {
        const methodMatch =
          /^(?:(public|protected|private)\s+)?(?:static\s+)?(?:readonly\s+)?(?:async\s+)?\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/.exec(
            cleanTrimmed
          );
        if (
          methodMatch &&
          !["if", "for", "while", "switch", "catch", "function", "return"].includes(methodMatch[2])
        ) {
          const vis = (methodMatch[1] as Visibility) || "public";
          const name = methodMatch[2];
          const params = methodMatch[3];
          const retType = methodMatch[4] ? `: ${methodMatch[4].trim()}` : "";
          const endLine = findBraceBlockEnd(cleanLines, i);
          const nestingDepth = calculateControlFlowNesting(rawLines, i, endLine - 1);
          symbols.push({
            name: `${currentClass}::${name}`,
            kind: "method",
            signature: `${vis} ${name}(${params})${retType}`,
            visibility: vis,
            line_start: lineNum,
            line_end: endLine,
            line_count: Math.max(1, endLine - lineNum + 1),
            nesting_depth: nestingDepth,
          });
        } else {
          const propMatch =
            /^(?:(public|protected|private)\s+)?(?:static\s+)?(?:readonly\s+)?\b([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\?|\!)?\s*(?::\s*([^;={]+))?(?:\s*=[^;]+)?;\s*$/.exec(
              cleanTrimmed
            );
          if (
            propMatch &&
            !["return", "const", "let", "var", "throw", "import", "export", "continue", "break"].includes(
              propMatch[2]
            )
          ) {
            const vis = (propMatch[1] as Visibility) || "public";
            const propName = propMatch[2];
            const typeStr = propMatch[3] ? `: ${propMatch[3].trim()}` : "";
            symbols.push({
              name: `${currentClass}::${propName}`,
              kind: "property",
              signature: `${vis} ${propName}${typeStr}`,
              visibility: vis,
              line_start: lineNum,
              line_end: lineNum,
              line_count: 1,
            });
          }
        }
      }

      for (const ch of cleanLines[i]) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
      }
      if (currentClass && braceDepth < currentClassDepth) {
        currentClass = null;
        currentClassDepth = 0;
      }
    }

    return { symbols, dependencies };
  }

  private extractFromAst(rootNode: Parser.SyntaxNode, content: string): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];
    const lines = content.split("\n");

    const stripQuotes = (raw: string): string => raw.replace(/^['"`]|['"`]$/g, "");
    const getHeaderSignature = (node: Parser.SyntaxNode): string => {
      const firstLine = lines[node.startPosition.row] ?? "";
      return firstLine.trim().replace(/\{$/, "").replace(/;$/, "").trim();
    };

    const walkDependencies = (node: Parser.SyntaxNode): void => {
      if (node.type === "import_statement") {
        const sourceNode =
          node.childForFieldName("source") ??
          node.namedChildren.find((c) => c.type === "string");
        if (sourceNode) {
          const target = stripQuotes(sourceNode.text.trim());
          if (target) {
            const importedSymbols = this.extractImportedSymbols(node);
            const isExternal = !target.startsWith(".") && !target.startsWith("/");
            dependencies.push({
              target,
              statement: (lines[node.startPosition.row] ?? node.text).trim(),
              line_number: node.startPosition.row + 1,
              is_external: isExternal,
              ...(importedSymbols.length > 0 ? { imported_symbols: importedSymbols } : {}),
            });
          }
        }
        return;
      }

      if (node.type === "call_expression") {
        const fnNode = node.childForFieldName("function") ?? node.namedChildren[0];
        const argsNode = node.childForFieldName("arguments") ?? node.namedChildren.find((c) => c.type === "arguments");
        if (fnNode && (fnNode.text === "require" || fnNode.type === "import") && argsNode) {
          const firstArg = argsNode.namedChildren[0];
          if (firstArg && (firstArg.type === "string" || firstArg.type === "template_string")) {
            const target = stripQuotes(firstArg.text.trim());
            if (target && !target.includes("${")) {
              const importedSymbols = this.extractRequireImportedSymbols(node);
              const isExternal = !target.startsWith(".") && !target.startsWith("/");
              dependencies.push({
                target,
                statement: (lines[node.startPosition.row] ?? node.text).trim(),
                line_number: node.startPosition.row + 1,
                is_external: isExternal,
                ...(importedSymbols.length > 0 ? { imported_symbols: importedSymbols } : {}),
              });
            }
          }
        }
      }

      for (const child of node.namedChildren) {
        walkDependencies(child);
      }
    };

    walkDependencies(rootNode);

    const processTopLevelNode = (stmtNode: Parser.SyntaxNode, isExported: boolean, outerStartRow?: number): void => {
      const startRow = outerStartRow ?? stmtNode.startPosition.row;
      const endRow = stmtNode.endPosition.row;
      const lineStart = startRow + 1;
      const lineEnd = Math.max(lineStart, endRow + 1);
      const lineCount = Math.max(1, lineEnd - lineStart + 1);

      if (stmtNode.type === "export_statement") {
        const decl =
          stmtNode.childForFieldName("declaration") ??
          stmtNode.namedChildren.find((c) => c.type !== "decorator" && c.type !== "export_clause");
        if (decl) {
          processTopLevelNode(decl, true, stmtNode.startPosition.row);
        }
        return;
      }

      if (
        stmtNode.type === "class_declaration" ||
        stmtNode.type === "abstract_class_declaration" ||
        stmtNode.type === "interface_declaration"
      ) {
        const nameNode =
          stmtNode.childForFieldName("name") ??
          stmtNode.namedChildren.find((c) => c.type === "type_identifier" || c.type === "identifier");
        if (!nameNode) return;

        const className = nameNode.text;
        const kind: SymbolKind = stmtNode.type === "interface_declaration" ? "interface" : "class";
        symbols.push({
          name: className,
          kind,
          signature: getHeaderSignature(stmtNode),
          visibility: "public",
          line_start: lineStart,
          line_end: lineEnd,
          line_count: lineCount,
        });

        const bodyNode =
          stmtNode.childForFieldName("body") ??
          stmtNode.namedChildren.find(
            (c) => c.type === "class_body" || c.type === "interface_body" || c.type === "object_type"
          );
        if (bodyNode) {
          this.extractClassOrInterfaceMembers(className, bodyNode, symbols);
        }
        return;
      }

      if (stmtNode.type === "type_alias_declaration" || stmtNode.type === "enum_declaration") {
        const nameNode =
          stmtNode.childForFieldName("name") ??
          stmtNode.namedChildren.find((c) => c.type === "type_identifier" || c.type === "identifier");
        if (!nameNode) return;

        symbols.push({
          name: nameNode.text,
          kind: stmtNode.type === "enum_declaration" ? "enum" : "type",
          signature: getHeaderSignature(stmtNode),
          visibility: "public",
          line_start: lineStart,
          line_end: lineEnd,
          line_count: lineCount,
        });
        return;
      }

      if (stmtNode.type === "function_declaration" || stmtNode.type === "generator_function_declaration") {
        const nameNode =
          stmtNode.childForFieldName("name") ??
          stmtNode.namedChildren.find((c) => c.type === "identifier");
        if (!nameNode) return;

        const fnName = nameNode.text;
        const paramsNode =
          stmtNode.childForFieldName("parameters") ??
          stmtNode.namedChildren.find((c) => c.type === "formal_parameters");
        const retNode = stmtNode.childForFieldName("return_type");
        const paramsText = paramsNode ? paramsNode.text : "()";
        const retText = retNode ? `: ${retNode.text.replace(/^:\s*/, "")}` : "";
        const nestingDepth = calculateAstControlFlowNesting(
          stmtNode,
          TS_CONTROL_FLOW_NODES,
          TS_FUNCTION_BOUNDARY_NODES
        );

        symbols.push({
          name: fnName,
          kind: "function",
          signature: `${fnName}${paramsText}${retText}`,
          visibility: "public",
          line_start: lineStart,
          line_end: lineEnd,
          line_count: lineCount,
          nesting_depth: nestingDepth,
        });
        return;
      }

      if (stmtNode.type === "lexical_declaration" || stmtNode.type === "variable_declaration") {
        this.extractVariableDeclarations(stmtNode, isExported, outerStartRow, symbols);
      }
    };

    for (const child of rootNode.namedChildren) {
      processTopLevelNode(child, false);
    }

    return { symbols, dependencies };
  }

  private extractVariableDeclarations(
    stmtNode: Parser.SyntaxNode,
    isExported: boolean,
    outerStartRow: number | undefined,
    symbols: ExtractedSymbol[]
  ): void {
    const declText = stmtNode.text.trimStart();
    const isConst = declText.startsWith("const ") || declText.startsWith("const\t");
    const declKeyword = isConst ? "const" : declText.startsWith("var ") ? "var" : "let";

    for (const child of stmtNode.namedChildren) {
      if (child.type !== "variable_declarator") continue;
      const nameNode = child.childForFieldName("name") ?? child.namedChildren[0];
      if (!nameNode || nameNode.type !== "identifier") continue;

      const varName = nameNode.text;
      const typeNode = child.childForFieldName("type");
      const valueNode = child.childForFieldName("value");
      const typeStr = typeNode ? `: ${typeNode.text.replace(/^:\s*/, "")}` : "";

      const dStart = (outerStartRow ?? child.startPosition.row) + 1;
      const dEnd = Math.max(dStart, child.endPosition.row + 1);
      const dCount = Math.max(1, dEnd - dStart + 1);

      if (
        valueNode &&
        (valueNode.type === "arrow_function" ||
          valueNode.type === "function_expression" ||
          valueNode.type === "function")
      ) {
        const paramsNode =
          valueNode.childForFieldName("parameters") ??
          valueNode.namedChildren.find((c) => c.type === "formal_parameters");
        const retNode = valueNode.childForFieldName("return_type");
        const paramsText = paramsNode ? paramsNode.text : "()";
        const retText = retNode ? `: ${retNode.text.replace(/^:\s*/, "")}` : typeStr;
        const nestingDepth = calculateAstControlFlowNesting(
          valueNode,
          TS_CONTROL_FLOW_NODES,
          TS_FUNCTION_BOUNDARY_NODES
        );

        symbols.push({
          name: varName,
          kind: "function",
          signature: `${varName}${paramsText}${retText}`,
          visibility: isExported ? "public" : "private",
          line_start: dStart,
          line_end: dEnd,
          line_count: dCount,
          nesting_depth: nestingDepth,
        });
      } else {
        symbols.push({
          name: varName,
          kind: isConst ? "constant" : "variable",
          signature: `${declKeyword} ${varName}${typeStr}`,
          visibility: isExported ? "public" : "private",
          line_start: dStart,
          line_end: dEnd,
          line_count: dCount,
        });
      }
    }
  }

  private extractClassOrInterfaceMembers(
    className: string,
    bodyNode: Parser.SyntaxNode,
    symbols: ExtractedSymbol[]
  ): void {
    for (const member of bodyNode.namedChildren) {
      const mStart = member.startPosition.row + 1;
      const mEnd = Math.max(mStart, member.endPosition.row + 1);
      const mCount = Math.max(1, mEnd - mStart + 1);

      if (
        member.type === "method_definition" ||
        member.type === "method_signature" ||
        member.type === "abstract_method_signature"
      ) {
        const nameNode =
          member.childForFieldName("name") ??
          member.namedChildren.find(
            (c) =>
              c.type === "property_identifier" ||
              c.type === "private_property_identifier" ||
              c.type === "identifier"
          );
        if (!nameNode) continue;

        const methodName = nameNode.text;
        const vis = this.extractVisibility(member, methodName);
        const paramsNode =
          member.childForFieldName("parameters") ??
          member.namedChildren.find((c) => c.type === "formal_parameters");
        const retNode = member.childForFieldName("return_type");
        const paramsText = paramsNode ? paramsNode.text : "()";
        const retText = retNode ? `: ${retNode.text.replace(/^:\s*/, "")}` : "";
        const nestingDepth = calculateAstControlFlowNesting(
          member,
          TS_CONTROL_FLOW_NODES,
          TS_FUNCTION_BOUNDARY_NODES
        );

        symbols.push({
          name: `${className}::${methodName}`,
          kind: "method",
          signature: `${vis} ${methodName}${paramsText}${retText}`,
          visibility: vis,
          line_start: mStart,
          line_end: mEnd,
          line_count: mCount,
          nesting_depth: nestingDepth,
        });
        continue;
      }

      if (
        member.type === "public_field_definition" ||
        member.type === "field_definition" ||
        member.type === "property_signature"
      ) {
        const nameNode =
          member.childForFieldName("name") ??
          member.namedChildren.find(
            (c) =>
              c.type === "property_identifier" ||
              c.type === "private_property_identifier" ||
              c.type === "identifier"
          );
        if (!nameNode) continue;

        const propName = nameNode.text;
        const vis = this.extractVisibility(member, propName);
        const typeNode = member.childForFieldName("type");
        const typeStr = typeNode ? `: ${typeNode.text.replace(/^:\s*/, "")}` : "";

        symbols.push({
          name: `${className}::${propName}`,
          kind: "property",
          signature: `${vis} ${propName}${typeStr}`,
          visibility: vis,
          line_start: mStart,
          line_end: mEnd,
          line_count: mCount,
        });
      }
    }
  }

  private extractVisibility(memberNode: Parser.SyntaxNode, memberName: string): Visibility {
    if (memberName.startsWith("#")) return "private";
    for (const child of memberNode.children) {
      if (child.type === "accessibility_modifier") {
        const text = child.text.trim();
        if (text === "private" || text === "protected" || text === "public") {
          return text;
        }
      }
    }
    return "public";
  }

  private extractImportedSymbols(importNode: Parser.SyntaxNode): string[] {
    const names = new Set<string>();
    const walkClause = (node: Parser.SyntaxNode): void => {
      if (node.type === "import_specifier") {
        const origName = node.childForFieldName("name") ?? node.namedChildren[0];
        const aliasName = node.childForFieldName("alias");
        if (origName && origName.text) names.add(origName.text.trim());
        if (aliasName && aliasName.text) names.add(aliasName.text.trim());
        return;
      }
      if (node.type === "namespace_import") {
        const idNode = node.namedChildren.find((c) => c.type === "identifier");
        if (idNode?.text) names.add(idNode.text.trim());
        return;
      }
      if (node.type === "import_clause") {
        for (const child of node.namedChildren) {
          if (child.type === "identifier") {
            names.add(child.text.trim());
          } else {
            walkClause(child);
          }
        }
        return;
      }
      for (const child of node.namedChildren) {
        if (child.type !== "string") {
          walkClause(child);
        }
      }
    };
    walkClause(importNode);
    return Array.from(names);
  }

  private extractRequireImportedSymbols(callNode: Parser.SyntaxNode): string[] {
    const names = new Set<string>();
    const parent = callNode.parent;
    if (parent && parent.type === "variable_declarator") {
      const nameNode = parent.childForFieldName("name") ?? parent.namedChildren[0];
      if (nameNode) {
        if (nameNode.type === "identifier") {
          names.add(nameNode.text.trim());
        } else if (nameNode.type === "object_pattern") {
          for (const prop of nameNode.namedChildren) {
            if (prop.type === "shorthand_property_identifier_pattern" || prop.type === "identifier") {
              names.add(prop.text.trim());
            } else if (prop.type === "pair_pattern") {
              const key = prop.childForFieldName("key") ?? prop.namedChildren[0];
              const val = prop.childForFieldName("value") ?? prop.namedChildren[1];
              if (key?.text) names.add(key.text.trim());
              if (val?.text) names.add(val.text.trim());
            }
          }
        }
      }
    }
    return Array.from(names);
  }
}



