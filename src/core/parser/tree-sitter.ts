import type { ParsedFileAST } from "../../types/index.ts";
import type { CodeExtractor } from "./extractors/base.ts";
import { FrontendExtractor } from "./extractors/frontend.ts";
import { GoExtractor } from "./extractors/go.ts";
import { PHPExtractor } from "./extractors/php.ts";
import { PythonExtractor } from "./extractors/python.ts";
import { TypeScriptExtractor } from "./extractors/typescript.ts";

export class ASTParserEngine {
  private extractors: CodeExtractor[];

  constructor() {
    this.extractors = [
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
        return extractor.extract(filePath, content);
      }
    }

    // Default fallback extractor for unknown file types
    return {
      symbols: [],
      dependencies: [],
    };
  }

  public registerExtractor(extractor: CodeExtractor): void {
    this.extractors.unshift(extractor);
  }
}
