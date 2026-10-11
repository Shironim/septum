import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
import { findBraceBlockEnd, calculateControlFlowNesting } from "../boundary-tracker.ts";
import type { CodeExtractor } from "./base.ts";

const GO_STDLIB_PREFIXES = new Set([
  "bufio",
  "bytes",
  "context",
  "crypto",
  "database",
  "encoding",
  "errors",
  "flag",
  "fmt",
  "html",
  "image",
  "io",
  "log",
  "math",
  "mime",
  "net",
  "os",
  "path",
  "plugin",
  "reflect",
  "regexp",
  "runtime",
  "sort",
  "strconv",
  "strings",
  "sync",
  "syscall",
  "testing",
  "text",
  "time",
  "unicode",
  "unsafe",
]);

import type Parser from "web-tree-sitter";
import { blankCommentsAndStrings } from "../boundary-tracker.ts";
import { calculateAstControlFlowNesting, parseWithTreeSitter } from "../wasm-loader.ts";

const GO_CONTROL_FLOW_NODES = new Set([
  "if_statement",
  "for_statement",
  "expression_switch_statement",
  "type_switch_statement",
  "select_statement",
]);

const GO_FUNCTION_BOUNDARY_NODES = new Set([
  "function_declaration",
  "method_declaration",
  "func_literal",
]);

export class GoExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return /\.go$/i.test(filePath);
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const astResult = await parseWithTreeSitter("go", content, (rootNode) =>
      this.extractFromAst(rootNode, filePath, content)
    );
    if (astResult) {
      return astResult;
    }

    return this.extractFallback(filePath, content);
  }

  private extractFallback(filePath: string, content: string): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const lines = content.split("\n");
    const cleanLines = blankCommentsAndStrings(content).split("\n");

    // 1. Extract Go Imports
    let inImportBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const cleanTrimmed = cleanLines[i].trim();
      const lineNum = i + 1;

      if (!cleanTrimmed || trimmed.startsWith("//")) continue;

      if (cleanTrimmed.startsWith("import (")) {
        inImportBlock = true;
        continue;
      }

      if (inImportBlock) {
        if (cleanTrimmed === ")") {
          inImportBlock = false;
          continue;
        }

        const blockMatch = /^(?:([\w.]+)\s+)?["'`]([^"'`]+)["'`]/.exec(trimmed);
        if (blockMatch) {
          const alias = blockMatch[1];
          const importPath = blockMatch[2];
          const isExternal = this.isExternalImport(importPath, filePath);
          const pkgSymbol = alias && alias !== "." && alias !== "_" ? alias : importPath.split("/").pop() || importPath;
          dependencies.push({
            target: importPath,
            statement: trimmed,
            line_number: lineNum,
            is_external: isExternal,
            imported_symbols: [pkgSymbol],
          });
        }
        continue;
      }

      const singleMatch = /^import\s+(?:([\w.]+)\s+)?["'`]([^"'`]+)["'`]/.exec(trimmed);
      if (singleMatch) {
        const alias = singleMatch[1];
        const importPath = singleMatch[2];
        const isExternal = this.isExternalImport(importPath, filePath);
        const pkgSymbol = alias && alias !== "." && alias !== "_" ? alias : importPath.split("/").pop() || importPath;
        dependencies.push({
          target: importPath,
          statement: trimmed,
          line_number: lineNum,
          is_external: isExternal,
          imported_symbols: [pkgSymbol],
        });
      }
    }

    // 2. Extract Go Types, Structs, Interfaces, and Functions
    for (let i = 0; i < cleanLines.length; i++) {
      const trimmed = cleanLines[i].trim();
      const rawTrimmed = lines[i].trim();
      const lineNum = i + 1;

      if (!trimmed) continue;

      const typeMatch = /^type\s+([A-Za-z0-9_]+)\s+(struct|interface)\b/.exec(trimmed);
      if (typeMatch) {
        const typeName = typeMatch[1];
        const kind = typeMatch[2] === "interface" ? "interface" : "class";
        const visibility: Visibility = /^[A-Z]/.test(typeName) ? "public" : "private";
        const endLine = findBraceBlockEnd(cleanLines, i);

        symbols.push({
          name: typeName,
          kind,
          signature: rawTrimmed.replace(/\{$/, "").trim(),
          visibility,
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
        continue;
      }

      const methodMatch = /^func\s*\([^)]+\)\s*([A-Za-z0-9_]+)\s*\([^)]*\)/.exec(trimmed);
      if (methodMatch) {
        const methodName = methodMatch[1];
        const visibility: Visibility = /^[A-Z]/.test(methodName) ? "public" : "private";
        const endLine = findBraceBlockEnd(cleanLines, i);
        const nestingDepth = calculateControlFlowNesting(lines, i, endLine - 1);

        symbols.push({
          name: methodName,
          kind: "method",
          signature: rawTrimmed.replace(/\{$/, "").trim(),
          visibility,
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
          nesting_depth: nestingDepth,
        });
        continue;
      }

      const funcMatch = /^func\s+([A-Za-z0-9_]+)\s*\([^)]*\)/.exec(trimmed);
      if (funcMatch) {
        const funcName = funcMatch[1];
        const visibility: Visibility = /^[A-Z]/.test(funcName) ? "public" : "private";
        const endLine = findBraceBlockEnd(cleanLines, i);
        const nestingDepth = calculateControlFlowNesting(lines, i, endLine - 1);

        symbols.push({
          name: funcName,
          kind: "function",
          signature: rawTrimmed.replace(/\{$/, "").trim(),
          visibility,
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
          nesting_depth: nestingDepth,
        });
      }
    }

    return {
      symbols,
      dependencies,
    };
  }


  private isExternalImport(importPath: string, filePath?: string): boolean {
    if (this.isGoStdlib(importPath)) {
      return true;
    }
    if (importPath.startsWith(".") || importPath.startsWith("/")) {
      return false;
    }
    const modName = this.findGoModuleName(filePath);
    if (modName) {
      if (importPath === modName || importPath.startsWith(`${modName}/`)) {
        return false;
      }
      return true;
    }

    if (
      importPath.includes("/domains/") ||
      importPath.includes("/internal/") ||
      importPath.includes("/pkg/")
    ) {
      return false;
    }

    if (importPath.includes(".")) {
      return true;
    }

    return false;
  }

  private findGoModuleName(filePath?: string): string | null {
    if (!filePath) return null;
    try {
      let currentDir = path.dirname(path.resolve(filePath));
      while (currentDir && currentDir !== path.dirname(currentDir)) {
        const goModPath = path.join(currentDir, "go.mod");
        if (fs.existsSync(goModPath)) {
          const content = fs.readFileSync(goModPath, "utf-8");
          const match = /^module\s+([^\s\r\n]+)/m.exec(content);
          if (match) return match[1];
        }
        currentDir = path.dirname(currentDir);
      }
    } catch {}
    return null;
  }

  private isGoStdlib(importPath: string): boolean {
    const rootSegment = importPath.split("/")[0];
    return GO_STDLIB_PREFIXES.has(rootSegment) || !importPath.includes(".");
  }

  private extractFromAst(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    content: string
  ): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];
    const lines = content.split("\n");

    const addImportSpec = (specNode: Parser.SyntaxNode): void => {
      const pathNode =
        specNode.childForFieldName("path") ??
        specNode.namedChildren.find(
          (c) => c.type === "interpreted_string_literal" || c.type === "raw_string_literal"
        );
      if (!pathNode) return;

      const importPath = pathNode.text.replace(/^["'`]|["'`]$/g, "").trim();
      if (!importPath) return;

      const nameNode =
        specNode.childForFieldName("name") ??
        specNode.namedChildren.find((c) => c.type === "package_identifier" || c.type === "dot" || c.type === "blank_identifier");
      const alias = nameNode?.text?.trim();
      const pkgSymbol =
        alias && alias !== "." && alias !== "_" ? alias : importPath.split("/").pop() || importPath;

      dependencies.push({
        target: importPath,
        statement: (lines[specNode.startPosition.row] ?? specNode.text).trim(),
        line_number: specNode.startPosition.row + 1,
        is_external: this.isExternalImport(importPath, filePath),
        imported_symbols: [pkgSymbol],
      });
    };

    for (const node of rootNode.namedChildren) {
      if (node.type === "import_declaration") {
        for (const child of node.namedChildren) {
          if (child.type === "import_spec") {
            addImportSpec(child);
          } else if (child.type === "import_spec_list") {
            for (const spec of child.namedChildren) {
              if (spec.type === "import_spec") {
                addImportSpec(spec);
              }
            }
          }
        }
        continue;
      }

      if (node.type === "type_declaration") {
        for (const spec of node.namedChildren) {
          if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
          const nameNode =
            spec.childForFieldName("name") ??
            spec.namedChildren.find((c) => c.type === "type_identifier");
          if (!nameNode) continue;

          const typeName = nameNode.text;
          const typeVal = spec.childForFieldName("type") ?? spec.namedChildren[1];
          const kind = typeVal?.type === "interface_type" ? "interface" : "class";
          const visibility: Visibility = /^[A-Z]/.test(typeName) ? "public" : "private";
          const lineStart = spec.startPosition.row + 1;
          const lineEnd = Math.max(lineStart, spec.endPosition.row + 1);
          const headerLine = (lines[spec.startPosition.row] ?? "").trim().replace(/\{$/, "").trim();

          symbols.push({
            name: typeName,
            kind,
            signature: headerLine || `type ${typeName}`,
            visibility,
            line_start: lineStart,
            line_end: lineEnd,
            line_count: Math.max(1, lineEnd - lineStart + 1),
          });
        }
        continue;
      }

      if (node.type === "method_declaration") {
        const nameNode =
          node.childForFieldName("name") ??
          node.namedChildren.find((c) => c.type === "field_identifier" || c.type === "identifier");
        if (!nameNode) continue;

        const methodName = nameNode.text;
        const visibility: Visibility = /^[A-Z]/.test(methodName) ? "public" : "private";
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = (lines[node.startPosition.row] ?? "").trim().replace(/\{$/, "").trim();
        const nestingDepth = calculateAstControlFlowNesting(
          node,
          GO_CONTROL_FLOW_NODES,
          GO_FUNCTION_BOUNDARY_NODES
        );

        symbols.push({
          name: methodName,
          kind: "method",
          signature: headerLine || `func ${methodName}()`,
          visibility,
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
          nesting_depth: nestingDepth,
        });
        continue;
      }

      if (node.type === "function_declaration") {
        const nameNode =
          node.childForFieldName("name") ??
          node.namedChildren.find((c) => c.type === "identifier");
        if (!nameNode) continue;

        const funcName = nameNode.text;
        const visibility: Visibility = /^[A-Z]/.test(funcName) ? "public" : "private";
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = (lines[node.startPosition.row] ?? "").trim().replace(/\{$/, "").trim();
        const nestingDepth = calculateAstControlFlowNesting(
          node,
          GO_CONTROL_FLOW_NODES,
          GO_FUNCTION_BOUNDARY_NODES
        );

        symbols.push({
          name: funcName,
          kind: "function",
          signature: headerLine || `func ${funcName}()`,
          visibility,
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
          nesting_depth: nestingDepth,
        });
      }
    }

    return { symbols, dependencies };
  }
}

