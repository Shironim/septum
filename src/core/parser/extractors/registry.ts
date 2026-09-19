import type {
  SemanticSliceExtractor,
  VerticalSliceCandidate,
} from "./semantic-extractor.interface.ts";
import { LaravelSemanticExtractor } from "./laravel-semantic.ts";
import { McpCliSemanticExtractor } from "./mcp-cli-semantic.ts";
import { NestJsSemanticExtractor } from "./nestjs-semantic.ts";

export class SemanticSliceExtractorRegistry {
  private static extractors: SemanticSliceExtractor[] = [
    new LaravelSemanticExtractor(),
    new McpCliSemanticExtractor(),
    new NestJsSemanticExtractor(),
  ];

  /**
   * Registers a new semantic slice extractor strategy.
   * Prepends to the list to give higher priority to custom extractors.
   */
  public static register(extractor: SemanticSliceExtractor): void {
    this.extractors.unshift(extractor);
  }

  /**
   * Returns all extractors capable of handling the specified project topology.
   */
  public static getExtractors(projectRoot: string, framework?: string): SemanticSliceExtractor[] {
    return this.extractors.filter((extractor) => extractor.canHandle(projectRoot, framework));
  }

  /**
   * Executes all matched extractors and combines their vertical slices.
   */
  public static async extractAllSlices(
    projectRoot: string,
    framework?: string,
    domainId?: number
  ): Promise<VerticalSliceCandidate[]> {
    const matched = this.getExtractors(projectRoot, framework);
    const combinedSlices: VerticalSliceCandidate[] = [];

    for (const extractor of matched) {
      const slices = await extractor.extractSlices(projectRoot, domainId);
      combinedSlices.push(...slices);
    }

    return combinedSlices;
  }
}
