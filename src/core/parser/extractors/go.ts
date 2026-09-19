import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
import { findBraceBlockEnd } from "../boundary-tracker.ts";
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

export class GoExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return /\.go$/i.test(filePath);
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const lines = content.split("\n");

    // 1. Extract Go Imports
    let inImportBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      if (trimmed.startsWith("//")) continue;

      if (trimmed === "import (") {
        inImportBlock = true;
        continue;
      }

      if (inImportBlock) {
        if (trimmed === ")") {
          inImportBlock = false;
          continue;
        }

        const blockMatch = /^(?:[\w.]+\s+)?["']([^"']+)["']/.exec(trimmed);
        if (blockMatch) {
          const importPath = blockMatch[1];
          const isExternal = this.isGoStdlib(importPath);
          dependencies.push({
            target: importPath,
            statement: trimmed,
            line_number: lineNum,
            is_external: isExternal,
          });
        }
        continue;
      }

      // Single line import: import "fmt" or import alias "pkg"
      const singleMatch = /^import\s+(?:[\w.]+\s+)?["']([^"']+)["']/.exec(trimmed);
      if (singleMatch) {
        const importPath = singleMatch[1];
        const isExternal = this.isGoStdlib(importPath);
        dependencies.push({
          target: importPath,
          statement: trimmed,
          line_number: lineNum,
          is_external: isExternal,
        });
      }
    }

    // 2. Extract Go Types, Structs, Interfaces, and Functions
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      if (trimmed.startsWith("//")) continue;

      // Struct or Interface: type User struct / type Reader interface
      const typeMatch = /^type\s+([A-Za-z0-9_]+)\s+(struct|interface)\b/.exec(trimmed);
      if (typeMatch) {
        const typeName = typeMatch[1];
        const kind = typeMatch[2] === "interface" ? "interface" : "class";
        const visibility: Visibility = /^[A-Z]/.test(typeName) ? "public" : "private";
        const endLine = findBraceBlockEnd(lines, i);

        symbols.push({
          name: typeName,
          kind,
          signature: trimmed.replace(/\{$/, "").trim(),
          visibility,
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
        continue;
      }

      // Method with receiver: func (r *Repo) FindUser(...) (...)
      const methodMatch = /^func\s*\([^)]+\)\s*([A-Za-z0-9_]+)\s*\([^)]*\)/.exec(trimmed);
      if (methodMatch) {
        const methodName = methodMatch[1];
        const visibility: Visibility = /^[A-Z]/.test(methodName) ? "public" : "private";
        const endLine = findBraceBlockEnd(lines, i);

        symbols.push({
          name: methodName,
          kind: "method",
          signature: trimmed.replace(/\{$/, "").trim(),
          visibility,
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
        continue;
      }

      // Function: func ProcessPayment(...) (...)
      const funcMatch = /^func\s+([A-Za-z0-9_]+)\s*\([^)]*\)/.exec(trimmed);
      if (funcMatch) {
        const funcName = funcMatch[1];
        const visibility: Visibility = /^[A-Z]/.test(funcName) ? "public" : "private";
        const endLine = findBraceBlockEnd(lines, i);

        symbols.push({
          name: funcName,
          kind: "function",
          signature: trimmed.replace(/\{$/, "").trim(),
          visibility,
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
      }
    }

    return {
      symbols,
      dependencies,
    };
  }

  private isGoStdlib(importPath: string): boolean {
    const rootSegment = importPath.split("/")[0];
    return GO_STDLIB_PREFIXES.has(rootSegment) || !importPath.includes(".");
  }
}
