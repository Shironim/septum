import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
import { findBraceBlockEnd } from "../boundary-tracker.ts";
import type { CodeExtractor } from "./base.ts";

export class TypeScriptExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath);
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const lines = content.split("\n");

    // 1. Extract Imports / Dependencies
    const importRegex = /(?:import\s+(?:(?:[\w*\s{},]+)\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(line)) !== null) {
        const target = match[1] || match[2];
        if (target) {
          const isExternal = !target.startsWith(".") && !target.startsWith("/");
          dependencies.push({
            target,
            statement: line.trim(),
            line_number: i + 1,
            is_external: isExternal,
          });
        }
      }
    }

    // 2. Extract Symbols (Classes, Interfaces, Types, Functions, Methods)
    let currentClass: string | null = null;
    let currentClassEndLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      if (currentClass && lineNum > currentClassEndLine) {
        currentClass = null;
        currentClassEndLine = 0;
      }

      // Class / Interface / Type definition
      const classMatch = /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface)\s+([A-Za-z0-9_]+)/.exec(trimmed);
      if (classMatch) {
        currentClass = classMatch[2];
        const endLine = findBraceBlockEnd(lines, i);
        currentClassEndLine = endLine;
        symbols.push({
          name: classMatch[2],
          kind: classMatch[1] as "class" | "interface",
          signature: trimmed.replace(/\{$/, "").trim(),
          visibility: "public",
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
        continue;
      }

      // Type Alias
      const typeMatch = /(?:export\s+)?type\s+([A-Za-z0-9_]+)\s*=/.exec(trimmed);
      if (typeMatch) {
        const endLine = trimmed.endsWith(";") ? lineNum : findBraceBlockEnd(lines, i);
        symbols.push({
          name: typeMatch[1],
          kind: "type",
          signature: trimmed.replace(/;$/, "").trim(),
          visibility: "public",
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
        continue;
      }

      // Enum Declaration
      const enumMatch = /(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_]+)/.exec(trimmed);
      if (enumMatch) {
        const endLine = findBraceBlockEnd(lines, i);
        symbols.push({
          name: enumMatch[1],
          kind: "enum",
          signature: trimmed.replace(/\{$/, "").trim(),
          visibility: "public",
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
        continue;
      }

      // Function Declaration
      const fnMatch = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/.exec(trimmed);
      if (fnMatch) {
        const name = fnMatch[1];
        const params = fnMatch[2];
        const retType = fnMatch[3] ? `: ${fnMatch[3].trim()}` : "";
        const endLine = findBraceBlockEnd(lines, i);
        symbols.push({
          name,
          kind: "function",
          signature: `${name}(${params})${retType}`,
          visibility: "public",
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
        continue;
      }

      // Exported Constants / Variables at module level
      const constMatch = /^export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)\s*(?::\s*([^=;]+))?\s*=/.exec(trimmed);
      if (constMatch) {
        const varName = constMatch[1];
        const typeStr = constMatch[2] ? `: ${constMatch[2].trim()}` : "";
        symbols.push({
          name: varName,
          kind: "property",
          signature: `const ${varName}${typeStr}`,
          visibility: "public",
          line_start: lineNum,
          line_end: lineNum,
          line_count: 1,
        });
        continue;
      }

      // Method or Property in class
      if (currentClass) {
        // Class property: public foo: string; or private bar = 1;
        const propMatch = /^(?:(public|protected|private)\s+)?(?:readonly\s+)?([A-Za-z0-9_]+)\s*(?:\?|\!)?\s*(?::\s*([^;={]+))?(?:\s*=[^;]+)?;\s*$/.exec(trimmed);
        if (propMatch && !["return", "const", "let", "var", "throw", "import"].includes(propMatch[2])) {
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
          continue;
        }

        const methodMatch = /^(?:(public|protected|private)\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/.exec(trimmed);
        if (methodMatch && !["if", "for", "while", "switch", "catch"].includes(methodMatch[2])) {
          const vis = (methodMatch[1] as Visibility) || "public";
          const name = methodMatch[2];
          const params = methodMatch[3];
          const retType = methodMatch[4] ? `: ${methodMatch[4].trim()}` : "";
          const endLine = findBraceBlockEnd(lines, i);
          symbols.push({
            name: `${currentClass}::${name}`,
            kind: "method",
            signature: `${vis} ${name}(${params})${retType}`,
            visibility: vis,
            line_start: lineNum,
            line_end: endLine,
            line_count: Math.max(1, endLine - lineNum + 1),
          });
        }
      }
    }

    return { symbols, dependencies };
  }
}
