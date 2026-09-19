export * from "./types/index.ts";
export * from "./core/config/schema.ts";
export * from "./core/config/loader.ts";
export * from "./core/database/client.ts";
export * from "./core/database/repository.ts";
export * from "./core/parser/extractors/base.ts";
export * from "./core/parser/tree-sitter.ts";
export * from "./core/ingestion/pipeline.ts";
export * from "./core/boundary/evaluator.ts";
export * from "./core/resolver/call-graph-tracer.ts";
export * from "./core/resolver/vertical-slice-tracer.ts";
export * from "./mcp/server.ts";
export * from "./cli/index.ts";

import { runCLI } from "./cli/index.ts";
if (import.meta.main) {
  runCLI(process.argv);
}
