import type { ParsedFileAST } from "../../types/index.ts";
import type { CodeExtractor } from "./extractors/base.ts";
import { BladeExtractor } from "./extractors/blade.ts";
import { FrontendExtractor } from "./extractors/frontend.ts";
import { GoExtractor } from "./extractors/go.ts";
import { PHPExtractor } from "./extractors/php.ts";
import { PythonExtractor } from "./extractors/python.ts";
import { TypeScriptExtractor } from "./extractors/typescript.ts";

export class ASTParserEngine {
  public static isSourceFile(filePath: string): boolean {
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|php|py|go|rs|java|cs|rb|vue|astro|svelte)$/i.test(filePath);
  }
  private extractors: CodeExtractor[];

  constructor() {
    this.extractors = [
      new BladeExtractor(),
      new FrontendExtractor(),
      new TypeScriptExtractor(),
      new PHPExtractor(),
      new PythonExtractor(),
      new GoExtractor(),
    ];
  }

  public async parseFile(filePath: string, content: string): Promise<ParsedFileAST> {
    for (const extractor of this.extractors) {
      if (extractor.canHandle(filePath)) {
        const result = await extractor.extract(filePath, content);
        return { status: "parsed", ...result };
      }
    }

    // Default fallback extractor for unknown file types
    return {
      status: "unsupported",
      symbols: [],
      dependencies: [],
    };
  }

  public registerExtractor(extractor: CodeExtractor): void {
    this.extractors.unshift(extractor);
  }
}
