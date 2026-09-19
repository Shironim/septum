import { watch, type FSWatcher } from "node:fs";
import { extname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BoundaryEvaluator } from "../core/boundary/evaluator.ts";
import { ConfigLoader } from "../core/config/loader.ts";
import { SeptumDatabase } from "../core/database/client.ts";
import { SeptumRepository } from "../core/database/repository.ts";
import { IngestionPipeline } from "../core/ingestion/pipeline.ts";
import { SessionManager } from "../core/session/session-manager.ts";
import { SeptumTelemetry } from "../core/telemetry/telemetry.ts";
import {
  handleCheckBoundary,
  type CheckBoundaryArgs,
} from "./tools/check-boundary.ts";
import {
  handleGetDomainCatalog,
  type GetDomainCatalogArgs,
} from "./tools/get-domain-catalog.ts";
import {
  handleClearFeatureContext,
  handleGetFeatureContext,
  type GetFeatureContextArgs,
} from "./tools/get-feature-context.ts";
import {
  handleLocateSymbol,
  type LocateSymbolArgs,
} from "./tools/locate-symbol.ts";
import {
  handleTraceVerticalSlice,
  type TraceVerticalSliceArgs,
} from "./tools/trace-vertical-slice.ts";
import {
  handleGetSymbolHotspots,
  type GetSymbolHotspotsArgs,
} from "./tools/get-symbol-hotspots.ts";
import { handleGetSymbol } from "./tools/get-symbol.ts";
import { handleGetSymbolImpact } from "./tools/get-symbol-impact.ts";
import { handleRegisterDomain } from "./tools/register-domain.ts";
import type { GetSymbolArgs, GetSymbolImpactArgs } from "../types/index.ts";
import {
  CheckBoundarySchema,
  GetDomainCatalogSchema,
  GetFeatureContextSchema,
  GetSymbolHotspotsSchema,
  GetSymbolImpactSchema,
  GetSymbolSchema,
  LocateSymbolSchema,
  RegisterDomainSchema,
  TraceVerticalSliceSchema,
} from "./schemas.ts";

export async function runMCPServer(): Promise<void> {
  const config = ConfigLoader.load();
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo);

  const server = new Server(
    {
      name: "septum-mcp-server",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "septum_get_domain_catalog",
          description:
            "Returns the authoritative structural catalog of a domain (files, archetypes, public signatures, and boundary rules). If 'domain' is omitted, returns the complete Macro Semantic Map (Telescope View) of the whole project. Token-efficient (< 400 tokens). Use this INSTEAD of browsing raw files.",
          inputSchema: {
            type: "object",
            properties: {
              domain: {
                type: "string",
                description: "Optional domain to inspect (e.g. 'orders', 'core'). If omitted, returns the project-wide Macro Semantic Map.",
              },
              archetype_filter: {
                type: "string",
                description: "Optional filter: 'service' | 'model' | 'controller' | 'repository'",
              },
            },
            required: [],
          },
        },
        {
          name: "septum_get_feature_context",
          description:
            "Returns authoritative task/feature context (< 300 tokens) including allowed_touchpoints, reusable symbols with signatures, and contracts. Use this when implementing a specific feature.",
          inputSchema: {
            type: "object",
            properties: {
              feature: {
                type: "string",
                description: "Key/name of the feature to inspect (e.g. 'checkout_flow')",
              },
            },
            required: ["feature"],
          },
        },
        {
          name: "septum_check_boundary",
          description:
            "Pre-flight boundary check to verify proposed file changes and imports against domain rules and feature touchpoints. Rejects illegal cross-domain dependencies before writing to disk.",
          inputSchema: {
            type: "object",
            properties: {
              file_path: {
                type: "string",
                description: "Path of the file being edited or created (single file check)",
              },
              file_paths: {
                type: "array",
                items: { type: "string" },
                description: "List of file paths being edited or created in a batch check",
              },
              proposed_imports: {
                type: "array",
                items: { type: "string" },
                description: "List of import statements or target symbols proposed for the file",
              },
              feature_key: {
                type: "string",
                description: "Optional feature key to validate touchpoints against.",
              },
            },
          },
        },
        {
          name: "septum_get_symbol_hotspots",
          description:
            "Discovers oversized functions, methods, and classes exceeding a specified line count threshold (default: 30 lines). Essential for Single Responsibility Principle (SRP) enforcement, finding God Functions, and isolating refactoring targets deterministically without reading raw files.",
          inputSchema: {
            type: "object",
            properties: {
              min_lines: {
                type: "number",
                description: "Minimum physical lines of code (LoC) threshold (default: 30).",
              },
              kind: {
                type: "string",
                description: "Filter by symbol kind ('function', 'method', 'class', 'struct', 'interface').",
              },
              domain: {
                type: "string",
                description: "Filter by domain name.",
              },
              limit: {
                type: "number",
                description: "Maximum results to return (default: 30).",
              },
            },
          },
        },
        {
          name: "septum_clear_feature_context",
          description:
            "Releases the active feature session lock (.septum/session.json) once feature implementation or editing is complete.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "septum_locate_symbol",
          description:
            "Locates a symbol or resolves diagnostic error logs (e.g. 'OrderController::calculateTotal()' or 'Method X::y() does not exist'). Returns target file path, existing sibling methods, and ranked alternative suggestions when a method doesn't exist.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Symbol name, call syntax (e.g. 'OrderController::calculateTotal'), or error log snippet (e.g. 'Method OrderController::calculateTotal() does not exist')",
              },
              domain: {
                type: "string",
                description: "Optional domain filter (e.g. 'orders')",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "septum_trace_vertical_slice",
          description:
            "Traces the end-to-end vertical slice of an MVC/Inertia application (Route -> Request Validation -> Controller Action -> Model -> Frontend View/Component). Accepts route URIs, controller actions, or high-level feature intents without requiring manual file guessing.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Route URI (e.g. 'POST /orders/{id}/status'), action (e.g. 'OrderController@updateStatus'), or intent (e.g. 'Ubah status order di dashboard')",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "septum_get_symbol",
          description:
            "Retrieves physical coordinates and structural metadata of a symbol (exact start_line, end_line, total_lines, signature, visibility, injected dependencies, and outbound calls). Returns deterministic JSON for direct piping into view_file without line guessing.",
          inputSchema: {
            type: "object",
            properties: {
              symbol: {
                type: "string",
                description:
                  "Symbol name, e.g. 'OrderController::cancelOrder', 'OrderController', or 'cancelOrder'",
              },
              domain: {
                type: "string",
                description: "Optional domain filter (e.g. 'orders')",
              },
              include_dependencies: {
                type: "boolean",
                description: "Whether to include injected dependencies and outbound calls (default: true)",
              },
            },
            required: ["symbol"],
          },
        },
        {
          name: "septum_get_symbol_impact",
          description:
            "Calculates blast radius and maps all inbound callers/dependents of a symbol across domains. Prevents Local Scope Myopia by reporting all files, callers, and line numbers that depend on the target symbol before refactoring.",
          inputSchema: {
            type: "object",
            properties: {
              symbol: {
                type: "string",
                description:
                  "Target symbol to inspect, e.g. 'OrderService::cancelOrder' or 'OrderService'",
              },
            },
            required: ["symbol"],
          },
        },
        {
          name: "septum_register_domain",
          description:
            "Directly registers or updates a bounded-context domain in SQLite SSOT (Zero-Config). Use this to dynamically teach Septum about custom domain boundaries, allowed dependencies, and archetypes without touching any YAML files.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Unique domain name (e.g. 'orders', 'checkout', 'billing')",
              },
              root: {
                type: "string",
                description: "Root directory path for this domain (e.g. 'src/domains/orders', 'app/Domain/Orders')",
              },
              description: {
                type: "string",
                description: "Optional high-level architectural purpose of the domain",
              },
              allowed_dependencies: {
                type: "array",
                items: { type: "string" },
                description: "List of domain names this domain is allowed to import",
              },
              forbidden_dependencies: {
                type: "array",
                items: { type: "string" },
                description: "List of domain names strictly forbidden from being imported",
              },
              archetypes: {
                type: "object",
                description: "Layer archetypes (e.g. { 'service': 'src/services/**', 'model': 'src/models/**' })",
              },
              ingest_now: {
                type: "boolean",
                description: "Whether to immediately run AST ingestion on this domain's files (default: false)",
              },
            },
            required: ["name", "root"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startTime = performance.now();
    const activeSession = SessionManager.getActiveSession(process.cwd());
    const sessionPayload = activeSession
      ? { feature_key: activeSession.feature_key, domain: activeSession.domain }
      : null;

    const executeTool = async () => {
      if (name === "septum_get_domain_catalog") {
        const parsed = GetDomainCatalogSchema.safeParse(args ?? {});
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Validation Error] Invalid arguments for ${name}: ${parsed.error.message}`,
              },
            ],
          };
        }
        return handleGetDomainCatalog(repo, config, parsed.data);
      } else if (name === "septum_get_feature_context") {
        const parsed = GetFeatureContextSchema.safeParse(args ?? {});
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Validation Error] Invalid arguments for ${name}: ${parsed.error.message}`,
              },
            ],
          };
        }
        return handleGetFeatureContext(repo, config, parsed.data);
      } else if (name === "septum_locate_symbol") {
        const parsed = LocateSymbolSchema.safeParse(args ?? {});
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Validation Error] Invalid arguments for ${name}: ${parsed.error.message}`,
              },
            ],
          };
        }
        return handleLocateSymbol(repo, config, parsed.data);
      } else if (name === "septum_get_symbol") {
        const parsed = GetSymbolSchema.safeParse(args ?? {});
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Validation Error] Invalid arguments for ${name}: ${parsed.error.message}`,
              },
            ],
          };
        }
        return handleGetSymbol(repo, config, parsed.data);
      } else if (name === "septum_get_symbol_impact") {
        const parsed = GetSymbolImpactSchema.safeParse(args ?? {});
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Validation Error] Invalid arguments for ${name}: ${parsed.error.message}`,
              },
            ],
          };
        }
        return handleGetSymbolImpact(repo, config, parsed.data);
      } else if (name === "septum_trace_vertical_slice") {
        const parsed = TraceVerticalSliceSchema.safeParse(args ?? {});
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Validation Error] Invalid arguments for ${name}: ${parsed.error.message}`,
              },
            ],
          };
        }
        return handleTraceVerticalSlice(repo, config, parsed.data);
      } else if (name === "septum_clear_feature_context") {
        const cleared = handleClearFeatureContext();
        return {
          content: [
            {
              type: "text",
              text: cleared
                ? "Active feature session successfully released."
                : "No active feature session found to release.",
            },
          ],
        };
      } else if (name === "septum_check_boundary") {
        const parsed = CheckBoundarySchema.safeParse(args ?? {});
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Validation Error] Invalid arguments for ${name}: ${parsed.error.message}`,
              },
            ],
          };
        }
        return handleCheckBoundary(evaluator, config, parsed.data);
      } else if (name === "septum_get_symbol_hotspots") {
        const parsed = GetSymbolHotspotsSchema.safeParse(args ?? {});
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Validation Error] Invalid arguments for ${name}: ${parsed.error.message}`,
              },
            ],
          };
        }
        return handleGetSymbolHotspots(repo, config, parsed.data);
      } else if (name === "septum_register_domain") {
        const parsed = RegisterDomainSchema.safeParse(args ?? {});
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Validation Error] Invalid arguments for ${name}: ${parsed.error.message}`,
              },
            ],
          };
        }
        return await handleRegisterDomain(repo, config, parsed.data);
      } else {
        throw new Error(`Unknown tool: '${name}'`);
      }
    };

    try {
      const response = await executeTool();
      const durationMs = Math.round(performance.now() - startTime);

      let bytesOut = 0;
      let linesOut = 0;
      if (Array.isArray(response?.content)) {
        for (const item of response.content) {
          if (typeof item.text === "string") {
            bytesOut += Buffer.byteLength(item.text, "utf8");
            linesOut += item.text.split("\n").length;
          }
        }
      }

      SeptumTelemetry.recordToolCall({
        event: "tool_call_completed",
        tool: name,
        duration_ms: durationMs,
        input: (args as Record<string, any>) ?? {},
        metrics: { bytes_out: bytesOut, lines_out: linesOut },
        session: sessionPayload,
        status: response?.isError ? "error" : "success",
      });

      return response;
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      const errorInstance = err instanceof Error ? err : new Error(String(err));

      SeptumTelemetry.recordToolCall({
        event: "tool_call_failed",
        tool: name,
        duration_ms: durationMs,
        input: (args as Record<string, any>) ?? {},
        session: sessionPayload,
        status: "error",
        error: {
          message: errorInstance.message,
          stack: errorInstance.stack,
        },
      });

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `[Septum MCP Error] ${errorInstance.message}`,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();

  // In-process transparent background watcher for auto-syncing codebase changes
  let fsWatcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".tsx", ".jsx", ".php", ".py", ".go"]);
  const IGNORED_SEGMENTS = new Set([
    "node_modules",
    ".git",
    ".septum",
    ".strata",
    "dist",
    ".output",
    ".nuxt",
    ".next",
    ".cache",
    "coverage",
    ".turbo",
  ]);

  try {
    const bgPipeline = new IngestionPipeline(repo);
    const cwd = process.cwd();

    fsWatcher = watch(cwd, { recursive: true }, (_event, filename) => {
      if (!filename) return;

      const norm = filename.replace(/\\/g, "/");
      const parts = norm.split("/");
      if (parts.some((p) => IGNORED_SEGMENTS.has(p))) return;

      const ext = extname(norm).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          const freshConfig = ConfigLoader.load();
          const metrics = await bgPipeline.run(freshConfig);
          if (metrics.files_updated > 0) {
            console.error(
              `[Septum Watcher] Auto-synced ${metrics.files_updated} modified file(s) in ${metrics.duration_ms.toFixed(0)}ms.`
            );
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Septum Watcher Warning] Background auto-sync failed: ${msg}`);
        }
      }, 300);
    });

    fsWatcher.on("error", (err: Error) => {
      console.error(`[Septum Watcher] File watcher error: ${err.message}`);
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Septum Watcher Warning] Could not start filesystem watcher: ${msg}`);
  }

  const cleanup = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (fsWatcher) {
      try {
        fsWatcher.close();
      } catch {
        // Ignore watcher close errors during shutdown
      }
    }
    try {
      db.close();
      console.error("[Septum MCP] Database connection closed cleanly.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Septum MCP] Error closing database during cleanup: ${msg}`);
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("beforeExit", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (fsWatcher) {
      try {
        fsWatcher.close();
      } catch {
        // Ignore watcher close errors
      }
    }
    try {
      db.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Septum MCP] Error closing database on beforeExit: ${msg}`);
    }
  });

  await server.connect(transport);
  console.error("[Septum MCP] Server started successfully on stdio transport.");
}
