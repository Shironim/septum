import type {
  SemanticSliceExtractor,
  VerticalSliceCandidate,
} from "./semantic-extractor.interface.ts";
import { LaravelSemanticExtractor } from "./laravel-semantic.ts";
import { SymfonySemanticExtractor } from "./symfony-semantic.ts";
import { McpCliSemanticExtractor } from "./mcp-cli-semantic.ts";
import { NestJsSemanticExtractor } from "./nestjs-semantic.ts";
import { FastApiSemanticExtractor } from "./fastapi-semantic.ts";
import { DjangoSemanticExtractor } from "./django-semantic.ts";
import { FlaskSemanticExtractor } from "./flask-semantic.ts";
import { GoSemanticExtractor } from "./go-semantic.ts";
import { ExpressSemanticExtractor } from "./express-semantic.ts";
import { FastifySemanticExtractor } from "./fastify-semantic.ts";
import { HonoSemanticExtractor } from "./hono-semantic.ts";
import { ElysiaSemanticExtractor } from "./elysia-semantic.ts";

export class SemanticSliceExtractorRegistry {
  private static extractors: SemanticSliceExtractor[] = [
    new LaravelSemanticExtractor(),
    new SymfonySemanticExtractor(),
    new McpCliSemanticExtractor(),
    new NestJsSemanticExtractor(),
    new ExpressSemanticExtractor(),
    new FastifySemanticExtractor(),
    new HonoSemanticExtractor(),
    new ElysiaSemanticExtractor(),
    new FastApiSemanticExtractor(),
    new DjangoSemanticExtractor(),
    new FlaskSemanticExtractor(),
    new GoSemanticExtractor(),
  ];

  public static getCapabilities() {
    return this.extractors.map(({ id, name }) => ({ id, name, coverage: "partial" }));
  }

  /**
   * Registers a new semantic slice extractor strategy.
   * Prepends to the list to give higher priority to custom extractors.
   */
  public static register(extractor: SemanticSliceExtractor): () => void {
    this.extractors.unshift(extractor);
    return () => { this.extractors = this.extractors.filter(item => item !== extractor); };
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
    domainId?: number,
    signal?: AbortSignal
  ): Promise<VerticalSliceCandidate[]> {
    const matched = this.getExtractors(projectRoot, framework);
    const combinedSlices: VerticalSliceCandidate[] = [];

    for (const extractor of matched) {
      signal?.throwIfAborted();
      let slices: VerticalSliceCandidate[];
      try { slices = await extractor.extractSlices(projectRoot, domainId, signal); }
      catch (error) { signal?.throwIfAborted(); throw new Error(`Semantic adapter '${extractor.id}' failed: ${error instanceof Error ? error.message : String(error)}`); }
      signal?.throwIfAborted();
      combinedSlices.push(...slices);
    }

    return combinedSlices;
  }

}
