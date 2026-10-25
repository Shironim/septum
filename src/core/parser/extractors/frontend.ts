import { getLanguageCapability } from "../language-capabilities.ts";
import type {
  ExtractedDependency,
  ExtractedSymbol,
  ParsedFileAST,
} from "../../../types/index.ts";
import type { CodeExtractor } from "./base.ts";
import { TypeScriptExtractor } from "./typescript.ts";

export class FrontendExtractor implements CodeExtractor {
  private readonly tsExtractor = new TypeScriptExtractor();

  public canHandle(filePath: string): boolean {
    return getLanguageCapability(filePath)?.extractor === "frontend";
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const isVue = /\.vue$/i.test(filePath);
    const isAstro = /\.astro$/i.test(filePath);
    const isSvelte = /\.svelte$/i.test(filePath);

    if (isVue) {
      await this.extractVue(content, symbols, dependencies);
    } else if (isAstro) {
      await this.extractAstro(content, symbols, dependencies);
    } else if (isSvelte) {
      await this.extractSvelte(content, symbols, dependencies);
    }

    return { symbols, dependencies };
  }

  private async extractVue(
    content: string,
    symbols: ExtractedSymbol[],
    dependencies: ExtractedDependency[]
  ): Promise<void> {
    const scriptRegex = /<script(\s+[^>]*?)?>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const attributes = match[1] || "";
      const scriptBody = match[2];
      const isSetup = /\bsetup\b/i.test(attributes);

      const tagOpenMatch = fullMatch.match(/<script(\s+[^>]*?)?>/i);
      const tagOpenLen = tagOpenMatch ? tagOpenMatch[0].length : 0;
      const scriptStartOffset = match.index + tagOpenLen;
      const startLine = content.slice(0, scriptStartOffset).split("\n").length;

      await this.extractScriptContent(scriptBody, startLine, symbols, dependencies);

      if (isSetup) {
        const scriptLines = scriptBody.split("\n").length;
        symbols.push({
          name: "<script setup>",
          kind: "method",
          signature: "script setup",
          visibility: "public",
          line_start: startLine,
          line_end: startLine + scriptLines - 1,
          line_count: Math.max(1, scriptLines),
        });
      }
    }

    const definePropsMatch = content.match(/defineProps\s*<([^>]+)>/);
    if (definePropsMatch) {
      const line = content.slice(0, content.indexOf(definePropsMatch[0])).split("\n").length;
      const propLines = definePropsMatch[0].split("\n").length;
      symbols.push({
        name: "Props",
        kind: "interface",
        signature: `defineProps<${definePropsMatch[1]}>`,
        visibility: "public",
        line_start: line,
        line_end: line + propLines - 1,
        line_count: Math.max(1, propLines),
      });
    }
  }

  private async extractAstro(
    content: string,
    symbols: ExtractedSymbol[],
    dependencies: ExtractedDependency[]
  ): Promise<void> {
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatterMatch) {
      const scriptBody = frontmatterMatch[1];
      const startLine = 2;
      await this.extractScriptContent(scriptBody, startLine, symbols, dependencies);
    }
  }

  private async extractSvelte(
    content: string,
    symbols: ExtractedSymbol[],
    dependencies: ExtractedDependency[]
  ): Promise<void> {
    const scriptRegex = /<script(\s+[^>]*?)?>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const scriptBody = match[2];
      const tagOpenMatch = fullMatch.match(/<script(\s+[^>]*?)?>/i);
      const tagOpenLen = tagOpenMatch ? tagOpenMatch[0].length : 0;
      const scriptStartOffset = match.index + tagOpenLen;
      const startLine = content.slice(0, scriptStartOffset).split("\n").length;

      await this.extractScriptContent(scriptBody, startLine, symbols, dependencies);
    }
  }

  private async extractScriptContent(
    scriptContent: string,
    startLine: number,
    symbols: ExtractedSymbol[],
    dependencies: ExtractedDependency[]
  ): Promise<void> {
    const parsed = await this.tsExtractor.extract("component-script.ts", scriptContent);
    if (parsed.status === "degraded") throw new Error("Cannot reliably parse component script.");
    const delta = Math.max(0, startLine - 1);

    for (const dep of parsed.dependencies) {
      dependencies.push({
        ...dep,
        line_number: dep.line_number + delta,
      });
    }

    for (const sym of parsed.symbols) {
      const shiftedStart = sym.line_start + delta;
      const shiftedEnd = Math.max(shiftedStart, sym.line_end + delta);
      symbols.push({
        ...sym,
        line_start: shiftedStart,
        line_end: shiftedEnd,
        line_count: Math.max(1, shiftedEnd - shiftedStart + 1),
      });
    }
  }
}

