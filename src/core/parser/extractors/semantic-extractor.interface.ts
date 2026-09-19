import type { VerticalSliceRecord } from "../../../types/index.ts";

export type VerticalSliceCandidate = Omit<VerticalSliceRecord, "id" | "created_at">;

export interface SemanticSliceExtractor {
  readonly id: string;
  readonly name: string;

  /**
   * Determines if this extractor can handle the project topology.
   */
  canHandle(projectRoot: string, framework?: string): boolean;

  /**
   * Extracts vertical slices from the codebase.
   */
  extractSlices(
    projectRoot: string,
    domainId?: number
  ): Promise<VerticalSliceCandidate[]> | VerticalSliceCandidate[];
}
