import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
import { findBraceBlockEnd } from "../boundary-tracker.ts";
import type { CodeExtractor } from "./base.ts";

export class PHPExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return /\.php$/i.test(filePath);
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const lines = content.split("\n");

    // 1. Extract PHP use / import statements
    const useRegex = /^\s*use\s+([^;]+);/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = useRegex.exec(line);
      if (match) {
        const fullTarget = match[1].trim();
        // Remove 'function ' or 'const ' prefix if any
        const cleaned = fullTarget.replace(/^(function|const)\s+/, "");
        const isExternal =
          cleaned.startsWith("Illuminate\\") ||
          cleaned.startsWith("Symfony\\") ||
          cleaned.startsWith("Psr\\") ||
          cleaned.startsWith("Composer\\");

        dependencies.push({
          target: cleaned,
          statement: line.trim(),
          line_number: i + 1,
          is_external: isExternal,
        });
      }
    }

    // 2. Extract PHP Class / Interface / Trait / Enum
    let currentContainer: string | null = null;
    let currentContainerEndLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      if (currentContainer && lineNum > currentContainerEndLine) {
        currentContainer = null;
        currentContainerEndLine = 0;
      }

      // Class / Interface / Trait / Enum header
      const classMatch = /^(?:abstract\s+|final\s+|readonly\s+)*(class|interface|trait|enum)\s+([A-Za-z0-9_]+)/.exec(trimmed);
      if (classMatch) {
        currentContainer = classMatch[2];
        const endLine = findBraceBlockEnd(lines, i);
        currentContainerEndLine = endLine;
        symbols.push({
          name: classMatch[2],
          kind: classMatch[1] as any,
          signature: trimmed.replace(/\{$/, "").trim(),
          visibility: "public",
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
        continue;
      }

      // Methods or Properties in class/interface/trait/enum
      if (currentContainer) {
        // PHP Constant: const STATUS_ACTIVE = 'active';
        const constMatch = /^(?:(public|protected|private)\s+)?const\s+([A-Za-z0-9_]+)\s*=/.exec(trimmed);
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

        // PHP Property: public ?string $foo = null; or private readonly Bar $bar;
        const propMatch = /^(?:(public|protected|private)\s+)?(?:readonly\s+)?(?:static\s+)?(?:\??[A-Za-z0-9_\\\\]+\s+)?\$([A-Za-z0-9_]+)(?:\s*=[^;]+)?;\s*$/.exec(trimmed);
        if (propMatch && !trimmed.includes("function ")) {
          const vis = (propMatch[1] as Visibility) || "public";
          const propName = `$${propMatch[2]}`;
          symbols.push({
            name: `${currentContainer}::${propName}`,
            kind: "property",
            signature: `${vis} ${trimmed.replace(/;\s*$/, "")}`,
            visibility: vis,
            line_start: lineNum,
            line_end: lineNum,
            line_count: 1,
          });
          continue;
        }

        const methodMatch = /^(?:(public|protected|private)\s+)?(?:static\s+)?(?:final\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/.exec(trimmed);
        if (methodMatch) {
          const vis = (methodMatch[1] as Visibility) || "public";
          const name = methodMatch[2];
          const params = methodMatch[3].trim();
          const retType = methodMatch[4] ? `: ${methodMatch[4].trim()}` : "";
          const endLine = findBraceBlockEnd(lines, i);
          symbols.push({
            name: `${currentContainer}::${name}`,
            kind: "method",
            signature: `${vis} function ${name}(${params})${retType}`,
            visibility: vis,
            line_start: lineNum,
            line_end: endLine,
            line_count: Math.max(1, endLine - lineNum + 1),
          });
          continue;
        }
      }

      // Standalone Global Function in PHP
      const funcMatch = /^(?:final\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*:\s*([^;{]+))?/.exec(trimmed);
      if (funcMatch && !currentContainer) {
        const name = funcMatch[1];
        const params = funcMatch[2].trim();
        const retType = funcMatch[3] ? `: ${funcMatch[3].trim()}` : "";
        const endLine = findBraceBlockEnd(lines, i);
        symbols.push({
          name,
          kind: "function",
          signature: `function ${name}(${params})${retType}`,
          visibility: "public",
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
      }
    }

    return { symbols, dependencies };
  }
}
