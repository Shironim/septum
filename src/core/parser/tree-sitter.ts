import type { ParsedFileAST } from "../../types/index.ts";
import type { CodeExtractor } from "./extractors/base.ts";
import { BladeExtractor } from "./extractors/blade.ts";
import { FrontendExtractor } from "./extractors/frontend.ts";
import { GoExtractor } from "./extractors/go.ts";
import { PHPExtractor } from "./extractors/php.ts";
import { PythonExtractor } from "./extractors/python.ts";
import { TypeScriptExtractor } from "./extractors/typescript.ts";
import { RustExtractor } from "./extractors/rust.ts";
import { JavaExtractor } from "./extractors/java.ts";
import { CSharpExtractor } from "./extractors/csharp.ts";
import { RubyExtractor } from "./extractors/ruby.ts";

import { getLanguageCapability } from "./language-capabilities.ts";

export class ASTParserEngine {
  public static isSourceFile(filePath: string): boolean {
    return getLanguageCapability(filePath) !== undefined;
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
      new RustExtractor(),
      new JavaExtractor(),
      new CSharpExtractor(),
      new RubyExtractor(),
    ];
  }

  public async parseFile(filePath: string, content: string): Promise<ParsedFileAST> {
    for (const extractor of this.extractors) {
      if (extractor.canHandle(filePath)) {
        const result = await extractor.extract(filePath, content);
        const capability = getLanguageCapability(filePath);
        return {
          status: "parsed", ...result,
          extraction: result.extraction ?? { method: capability?.method ?? "fallback", coverage: "partial" },
          diagnostics: result.diagnostics ?? [],
        };
      }
    }

    // Default fallback extractor for unknown file types
    return {
      status: "unsupported",
      extraction: { method: "unsupported", coverage: "none" },
      diagnostics: [{ code: "extractor_unavailable", message: `No extractor registered for '${filePath}'.` }],
      symbols: [],
      dependencies: [],
    };
  }

  public registerExtractor(extractor: CodeExtractor): void {
    this.extractors.unshift(extractor);
  }
}
