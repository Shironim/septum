import type {
  ExtractedDependency,
  ExtractedSymbol,
  ParsedFileAST,
} from "../../../types/index.ts";
import type { CodeExtractor } from "./base.ts";

export class FrontendExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return /\.(vue|astro|svelte)$/i.test(filePath);
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const isVue = /\.vue$/i.test(filePath);
    const isAstro = /\.astro$/i.test(filePath);
    const isSvelte = /\.svelte$/i.test(filePath);

    if (isVue) {
      this.extractVue(content, symbols, dependencies);
    } else if (isAstro) {
      this.extractAstro(content, symbols, dependencies);
    } else if (isSvelte) {
      this.extractSvelte(content, symbols, dependencies);
    }

    return { symbols, dependencies };
  }

  private extractVue(
    content: string,
    symbols: ExtractedSymbol[],
    dependencies: ExtractedDependency[]
  ): void {
    // Match <script> and <script setup> blocks
    const scriptRegex = /<script(\s+[^>]*?)?>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const attributes = match[1] || "";
      const scriptBody = match[2];
      const isSetup = /\bsetup\b/i.test(attributes);

      // Calculate start line of the script body
      const beforeMatch = content.slice(0, match.index);
      const tagOpenMatch = fullMatch.match(/<script(\s+[^>]*?)?>/i);
      const tagOpenLen = tagOpenMatch ? tagOpenMatch[0].length : 0;
      const scriptStartOffset = match.index + tagOpenLen;
      const startLine = content.slice(0, scriptStartOffset).split("\n").length;

      // Extract symbols and dependencies from this script block
      this.extractScriptContent(scriptBody, startLine, symbols, dependencies);

      if (isSetup) {
        symbols.push({
          name: "<script setup>",
          kind: "method",
          signature: "script setup",
          visibility: "public",
          line_start: startLine,
          line_end: startLine + scriptBody.split("\n").length,
          line_count: scriptBody.split("\n").length,
        });
      }
    }

    // Vue defineProps / defineEmits detection
    const definePropsMatch = content.match(/defineProps\s*<([^>]+)>/);
    if (definePropsMatch) {
      const line = content.slice(0, content.indexOf(definePropsMatch[0])).split("\n").length;
      symbols.push({
        name: "Props",
        kind: "interface",
        signature: `defineProps<${definePropsMatch[1]}>`,
        visibility: "public",
        line_start: line,
        line_end: line,
        line_count: 1,
      });
    }
  }

  private extractAstro(
    content: string,
    symbols: ExtractedSymbol[],
    dependencies: ExtractedDependency[]
  ): void {
    // Astro frontmatter is between the first --- and the second ---
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatterMatch) {
      const scriptBody = frontmatterMatch[1];
      const startLine = 2; // Line 1 is '---'
      this.extractScriptContent(scriptBody, startLine, symbols, dependencies);
    }
  }

  private extractSvelte(
    content: string,
    symbols: ExtractedSymbol[],
    dependencies: ExtractedDependency[]
  ): void {
    const scriptRegex = /<script(\s+[^>]*?)?>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const scriptBody = match[2];
      const tagOpenMatch = fullMatch.match(/<script(\s+[^>]*?)?>/i);
      const tagOpenLen = tagOpenMatch ? tagOpenMatch[0].length : 0;
      const scriptStartOffset = match.index + tagOpenLen;
      const startLine = content.slice(0, scriptStartOffset).split("\n").length;

      this.extractScriptContent(scriptBody, startLine, symbols, dependencies);
    }
  }

  private extractScriptContent(
    scriptContent: string,
    lineOffset: number,
    symbols: ExtractedSymbol[],
    dependencies: ExtractedDependency[]
  ): void {
    const lines = scriptContent.split("\n");

    // 1. Extract Imports
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
            line_number: lineOffset + i,
            is_external: isExternal,
          });
        }
      }
    }

    // 2. Extract Functions / Methods / Classes / Components
    const funcRegex = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/g;
    const constFuncRegex = /(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_]+)\s*=>/g;
    const classRegex = /(?:export\s+)?class\s+([a-zA-Z0-9_]+)/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const currentLineNum = lineOffset + i;

      let m: RegExpExecArray | null;
      while ((m = funcRegex.exec(line)) !== null) {
        symbols.push({
          name: m[1],
          kind: "function",
          signature: line.trim(),
          visibility: line.includes("export") ? "public" : "private",
          line_start: currentLineNum,
          line_end: currentLineNum,
          line_count: 1,
        });
      }

      while ((m = constFuncRegex.exec(line)) !== null) {
        symbols.push({
          name: m[1],
          kind: "function",
          signature: line.trim(),
          visibility: line.includes("export") ? "public" : "private",
          line_start: currentLineNum,
          line_end: currentLineNum,
          line_count: 1,
        });
      }

      while ((m = classRegex.exec(line)) !== null) {
        symbols.push({
          name: m[1],
          kind: "class",
          signature: line.trim(),
          visibility: line.includes("export") ? "public" : "private",
          line_start: currentLineNum,
          line_end: currentLineNum,
          line_count: 1,
        });
      }
    }
  }
}
