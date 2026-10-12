import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { relative, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BoundaryEvaluator } from "../core/boundary/evaluator.ts";
import { ModuleResolver } from "../core/resolver/module-resolver.ts";
import { ConfigLoader } from "../core/config/loader.ts";
import { SeptumDatabase } from "../core/database/client.ts";
import { SeptumRepository } from "../core/database/repository.ts";
import { IngestionPipeline } from "../core/ingestion/pipeline.ts";
import { ASTParserEngine } from "../core/parser/tree-sitter.ts";
import { SessionManager } from "../core/session/session-manager.ts";
import { SeptumTelemetry } from "../core/telemetry/telemetry.ts";
import { handleCheckBoundary } from "./tools/check-boundary.ts";
import { handleGetDomainCatalog } from "./tools/get-domain-catalog.ts";
import {
  handleClearFeatureContext,
  handleGetFeatureContext,
} from "./tools/get-feature-context.ts";
import { handleLocateSymbol } from "./tools/locate-symbol.ts";
import { handleTraceVerticalSlice } from "./tools/trace-vertical-slice.ts";
import { handleGetSymbolHotspots } from "./tools/get-symbol-hotspots.ts";
import { handleGetSymbol } from "./tools/get-symbol.ts";
import { handleGetSymbolImpact } from "./tools/get-symbol-impact.ts";
import { handleRegisterDomain } from "./tools/register-domain.ts";
import { handleRegisterFeature } from "./tools/register-feature.ts";
import { handleGetEnvironmentTopology } from "./tools/get-environment-topology.ts";
import {
  CheckBoundarySchema,
  GetDomainCatalogSchema,
  GetEnvironmentTopologySchema,
  GetFeatureContextSchema,
  GetSymbolHotspotsSchema,
  GetSymbolImpactSchema,
  GetSymbolSchema,
  LocateSymbolSchema,
  RegisterDomainSchema,
  RegisterFeatureSchema,
  TraceVerticalSliceSchema,
} from "./schemas.ts";
import { SEPTUM_VERSION } from "../version.ts";
import { resolveWorkspaceRoot } from "../core/resolver/path-resolver.ts";
import type { ValidatedSeptumConfig } from "../core/config/schema.ts";

interface WorkspaceContext {
  root: string;
  config: ValidatedSeptumConfig;
  db: SeptumDatabase;
  repo: SeptumRepository;
  evaluator: BoundaryEvaluator;
  pipeline: IngestionPipeline;
  ready: Promise<void>;
  watcher: { flush: () => Promise<void>; close: () => void };
}

const workspaceContextCache = new Map<string, WorkspaceContext>();

export function extractPathHint(args: unknown): string | undefined {
  if (!args) return undefined;

  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed.length > 0) return trimmed;
    return undefined;
  }

  if (Array.isArray(args)) {
    if (typeof args[0] === "string" && args[0].trim()) {
      return args[0].trim();
    }
    return undefined;
  }

  if (typeof args === "object" && args !== null) {
    const record = args as Record<string, any>;

    const explicitWorkspace =
      record.workspace_path ??
      record.workspacePath ??
      record.workspace ??
      record.project_root ??
      record.projectRoot ??
      record.target_path ??
      record.targetPath;
    if (typeof explicitWorkspace === "string" && explicitWorkspace.trim()) {
      return explicitWorkspace.trim();
    }

    const filePath =
      record.file_path ??
      record.filePath ??
      record.from_file ??
      record.fromFile ??
      record.source_file ??
      record.sourceFile ??
      record.entry_file ??
      record.entryFile;
    if (typeof filePath === "string" && filePath.trim()) {
      return filePath.trim();
    }

    const filePaths =
      record.file_paths ??
      record.filePaths ??
      record.files ??
      record.paths;
    if (Array.isArray(filePaths) && typeof filePaths[0] === "string" && filePaths[0].trim()) {
      return filePaths[0].trim();
    }
    if (typeof filePaths === "string" && filePaths.trim()) {
      return filePaths.trim();
    }

    if (
      !record.domain &&
      !record.name &&
      !record.domain_name &&
      !record.domainName &&
      typeof record.root === "string" &&
      record.root.trim()
    ) {
      return record.root.trim();
    }
  }

  return undefined;
}

function createWorkspaceWatcher(root: string, repo: SeptumRepository, pipeline: IngestionPipeline, ready: Promise<void>) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> | null = null;
  let closed = false;
  let needsFullSync = false;
  const ignored = new Set(["node_modules", "vendor", ".git", ".septum", ".strata", "dist", "build", ".output", ".nuxt", ".next", ".cache", "coverage", ".turbo"]);
  let watcher: FSWatcher | null = null;
  let polling: ReturnType<typeof setInterval> | null = null;

  const flush = async (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (flushing) return flushing;
    flushing = (async () => {
      await ready;
      if (!closed && (!watcher || needsFullSync || repo.getMeta("sync_error"))) {
        needsFullSync = false;
        await pipeline.run(ConfigLoader.load(undefined, root), { verifyContent: true });
        repo.setMeta("sync_error", "");
      }
      while (!closed && pending.size > 0) {
        const paths = [...pending];
        pending.clear();
        const config = ConfigLoader.load(undefined, root);
        for (const filename of paths) {
          const target = resolve(root, filename);
          const relPath = relative(root, target).replace(/\\/g, "/");
          if (!existsSync(target)) {
            repo.runInTransaction(() => { repo.deleteFileByPath(relPath); repo.clearVerticalSlices();
              const unsupported = JSON.parse(repo.getMeta("unsupported_files") || "[]") as string[];
              repo.setMeta("unsupported_files", JSON.stringify(unsupported.filter(path => path !== relPath))); });
          } else {
            await pipeline.ingestFile(target, config);
          }
        }
      }
    })();
    try { await flushing; } finally { flushing = null; }
  };

  const usePolling = (error: unknown) => {
    watcher?.close();
    watcher = null;
    repo.setMeta("watcher_mode", "polling");
    console.error(`[Septum Watcher Warning] Using polling: ${String(error)}`);
    if (!polling) polling = setInterval(() => {
      void flush().catch(failure => repo.setMeta("sync_error", String(failure)));
    }, 1000);
  };

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename || closed) return;
      const norm = filename.replace(/\\/g, "/");
      if (norm.split("/").some(segment => ignored.has(segment))) return;
      const target = resolve(root, norm);
      let directory = false;
      try { directory = statSync(target).isDirectory(); } catch { /* The path may have been removed before the event arrives. */ }
      if (directory || (!ASTParserEngine.isSourceFile(norm) && (repo.getAllFiles().some(file => file.path.startsWith(norm + "/")) || (JSON.parse(repo.getMeta("unsupported_files") || "[]") as string[]).some(file => file.startsWith(norm + "/"))))) {
        needsFullSync = true;
      } else if (ASTParserEngine.isSourceFile(norm)) {
        pending.add(norm);
      } else {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void flush().catch(error => {
          repo.setMeta("sync_error", String(error));
          console.error(`[Septum Watcher Warning] ${String(error)}`);
        });
      }, 300);
    });
    repo.setMeta("watcher_mode", "native");
    watcher.on("error", usePolling);
  } catch (error) {
    usePolling(error);
  }
  return { flush, close: () => { closed = true; if (timer) clearTimeout(timer); if (polling) clearInterval(polling); watcher?.close(); } };
}

function getWorkspaceContext(pathHint?: string): WorkspaceContext {
  const root = resolveWorkspaceRoot(pathHint);
  let ctx = workspaceContextCache.get(root);
  if (ctx) {
    return ctx;
  }

  const config = ConfigLoader.load(undefined, root);
  const rawDbPath = config.settings.db_path || ".septum/septum.db";
  const resolvedDbPath = resolve(root, rawDbPath);
  const db = new SeptumDatabase(resolvedDbPath);
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
  const pipeline = new IngestionPipeline(repo, root);

  const ready = pipeline.run(config, { verifyContent: true }).then(() => {});
  const watcher = createWorkspaceWatcher(root, repo, pipeline, ready);
  ctx = { root, config, db, repo, evaluator, pipeline, ready, watcher };
  workspaceContextCache.set(root, ctx);
  return ctx;
}

export async function runMCPServer(): Promise<void> {
  const initialCtx = getWorkspaceContext();
  await initialCtx.ready;

  const server = new Server(
    {
      name: "septum-mcp-server",
      version: SEPTUM_VERSION,
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
              detail_level: {
                type: "string",
                enum: ["compact", "full"],
                default: "compact",
                description: "Catalog detail level: 'compact' (default, token-efficient summary with file connections) or 'full' (includes full method/property signatures).",
              },
              file_filter: {
                type: "string",
                description: "Optional substring filter to inspect specific file(s) within the domain.",
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
              feature_key: {
                type: "string",
                description:
                  "Unique identifier for the feature to inspect (e.g. 'checkout_flow'). Symmetrically accepts 'feature'.",
              },
              feature: {
                type: "string",
                description: "Alias for 'feature_key'.",
              },
            },
            required: [],
          },
        },
        {
          name: "septum_check_boundary",
          description:
            "Pre-flight boundary check to verify proposed file changes and imports against domain rules and feature touchpoints, or audit the entire repository / staged files / domain for cross-domain and circular dependencies.",
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
              scope: {
                type: "string",
                enum: ["file", "all", "staged", "domain"],
                description: "Audit scope when file_path is omitted: 'all' (entire codebase), 'staged' (git staged files), 'domain' (specific domain), or 'file'.",
              },
              domain: {
                type: "string",
                description: "Optional domain name to filter boundary audit when scope is 'domain' or 'all'.",
              },
            },
          },
        },
        {
          name: "septum_get_symbol_hotspots",
          description:
            "Discovers oversized functions, methods, and classes exceeding a specified line count threshold or cyclomatic control flow nesting depth (> 4). Essential for Single Responsibility Principle (SRP) enforcement, finding God Functions / bug magnets, and isolating refactoring targets deterministically without reading raw files.",
          inputSchema: {
            type: "object",
            properties: {
              min_lines: {
                type: "number",
                description: "Minimum physical lines of code (LoC) threshold (default: 30).",
              },
              min_nesting: {
                type: "number",
                description: "Minimum control-flow nesting depth (e.g. nested if/for/while/try > 4).",
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
              sort_by: {
                type: "string",
                enum: ["lines", "nesting", "risk_score"],
                description: "Sorting criteria: 'risk_score' (combines lines & nesting depth), 'nesting', or 'lines'. Default: 'risk_score'.",
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
                  "Symbol name, call syntax (e.g. 'OrderController::calculateTotal'), or error log snippet. Symmetrically accepts 'symbol'.",
              },
              symbol: {
                type: "string",
                description: "Alias for 'query'.",
              },
              domain: {
                type: "string",
                description: "Optional domain filter (e.g. 'orders')",
              },
              limit: {
                type: "number",
                description: "Maximum number of suggestions to return (default: 10, max: 50).",
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
                  "Route URI (e.g. 'POST /orders/{id}/status'), action (e.g. 'OrderController@updateStatus'), or intent (e.g. 'Ubah status order di dashboard'). Symmetrically accepts 'symbol'.",
              },
              symbol: {
                type: "string",
                description: "Alias for 'query'.",
              },
              max_depth: {
                type: "number",
                default: 5,
                minimum: 1,
                maximum: 8,
                description: "Maximum depth to trace (default: 5, min: 1, max: 8).",
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
                  "Symbol name, e.g. 'OrderController::cancelOrder', 'OrderController', or 'cancelOrder'. Symmetrically accepts 'query'.",
              },
              query: {
                type: "string",
                description: "Alias for 'symbol'.",
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
                  "Target symbol to inspect, e.g. 'OrderService::cancelOrder' or 'OrderService'. Symmetrically accepts 'query'.",
              },
              query: {
                type: "string",
                description: "Alias for 'symbol'.",
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
              domain: {
                type: "string",
                description:
                  "Unique domain name/identifier (e.g. 'orders', 'checkout', 'billing'). Symmetrically accepts 'name'.",
              },
              name: {
                type: "string",
                description: "Alias for 'domain'.",
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
            required: ["domain", "root"],
          },
        },
        {
          name: "septum_register_feature",
          description:
            "Directly registers or updates a feature/task context in Septum SQLite SSOT. Establishes an active session lease (.septum/session.json) with allowed_touchpoints and reuse_symbols to enforce surgical blast-radius boundaries during code modifications.",
          inputSchema: {
            type: "object",
            properties: {
              feature_key: {
                type: "string",
                description:
                  "Unique identifier for the feature/task (e.g. 'penjualan', 'checkout-pos'). Symmetrically accepts 'feature'.",
              },
              feature: {
                type: "string",
                description: "Alias for 'feature_key'.",
              },
              domain: {
                type: "string",
                description: "Bounded-context domain to which this feature belongs",
              },
              description: {
                type: "string",
                description: "Scope and rationale for the feature",
              },
              allowed_touchpoints: {
                type: "array",
                items: { type: "string" },
                description: "List of file paths or glob patterns permitted to be edited for this feature",
              },
              reuse_symbols: {
                type: "array",
                items: { type: "string" },
                description: "Symbols/services/methods that must be reused rather than duplicated",
              },
              input_contract: {
                type: "object",
                description: "Expected input payload / DTO schema",
              },
              output_contract: {
                type: "object",
                description: "Expected output response / return contract",
              },
            },
            required: ["feature_key", "domain"],
          },
        },
        {
          name: "septum_get_environment_topology",
          description:
            "Self-Aware Production Topology Engine: Maps and verifies the 6-layer environment topology (Edge/WAF, Gateway/Web Server, Host Platform, Runtime, Storage/Cache, Telemetry). Identifies cross-layer constraints (e.g. Cloudflare + LiteSpeed + Laravel throttle), surfaces pending architectural inquiries if layers are ambiguous, and allows recording verified environment answers to SQLite SSOT.",
          inputSchema: {
            type: "object",
            properties: {
              resolve: {
                type: "object",
                properties: {
                  layer: {
                    type: "string",
                    enum: ["edge", "gateway", "host", "runtime", "storage", "telemetry"],
                    description: "Target layer to manually resolve/verify",
                  },
                  platform: {
                    type: "string",
                    description: "Confirmed platform name (e.g. 'Hostinger Shared Hosting', 'Cloudflare WAF', 'LiteSpeed')",
                  },
                  constraints: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional list of architectural constraints for this layer",
                  },
                },
                required: ["layer", "platform"],
                description: "Optional argument to record and verify a specific layer into SQLite SSOT",
              },
              resolveNode: {
                type: "object",
                properties: {
                  id: {
                    type: "string",
                    description: "Unique node identifier (e.g. 'api-gateway-1', 'db-primary')",
                  },
                  layer: {
                    type: "string",
                    enum: ["edge", "gateway", "host", "runtime", "storage", "telemetry"],
                    description: "Topology layer for this node",
                  },
                  name: {
                    type: "string",
                    description: "Human-readable node name",
                  },
                  platform: {
                    type: "string",
                    description: "Platform or infrastructure provider for this node",
                  },
                  domain_or_ip: {
                    type: "string",
                    description: "Optional domain or IP address of the node",
                  },
                  role: {
                    type: "string",
                    description: "Optional architectural role of the node",
                  },
                  connected_to: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional list of target node IDs this node connects to",
                  },
                },
                required: ["id", "layer", "name", "platform"],
                description: "Optional argument to record and verify a distributed topology node into SQLite SSOT",
              },
              refresh: {
                type: "boolean",
                description: "Force re-detection from codebase files, ignoring cached status",
              },
            },
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startTime = performance.now();
    const pathHint = extractPathHint(args as Record<string, any>);
    const ctx = getWorkspaceContext(pathHint);
    await ctx.ready;
    await ctx.watcher.flush();
    if (ctx.repo.getMeta("sync_error")) throw new Error(`Workspace index synchronization failed: ${ctx.repo.getMeta("sync_error")}`);
    ctx.config = ConfigLoader.load(undefined, ctx.root);
    ctx.evaluator.getResolver().setRepository(ctx.repo);

    const activeSession = SessionManager.getActiveSession(ctx.root);
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
        return handleGetDomainCatalog(ctx.repo, ctx.config, parsed.data, ctx.root);
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
        return handleGetFeatureContext(ctx.repo, ctx.config, parsed.data, ctx.root);
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
        return await handleLocateSymbol(ctx.repo, ctx.config, parsed.data, ctx.pipeline, ctx.root);
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
        return handleGetSymbol(ctx.repo, ctx.config, parsed.data, ctx.root);
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
        return handleGetSymbolImpact(ctx.repo, ctx.config, parsed.data, ctx.root);
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
        return handleTraceVerticalSlice(ctx.repo, ctx.config, parsed.data, ctx.root);
      } else if (name === "septum_clear_feature_context") {
        const cleared = handleClearFeatureContext(ctx.root);
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
        return handleCheckBoundary(ctx.evaluator, ctx.config, parsed.data, ctx.repo, ctx.root);
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
        return handleGetSymbolHotspots(ctx.repo, ctx.config, parsed.data, ctx.root);
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
        return await handleRegisterDomain(ctx.repo, ctx.config, parsed.data, ctx.root);
      } else if (name === "septum_register_feature") {
        const parsed = RegisterFeatureSchema.safeParse(args ?? {});
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
        return await handleRegisterFeature(ctx.repo, ctx.config, parsed.data, ctx.root);
      } else if (name === "septum_get_environment_topology") {
        const parsed = GetEnvironmentTopologySchema.safeParse(args ?? {});
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
        return handleGetEnvironmentTopology(ctx.repo, ctx.config, parsed.data, ctx.root);
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
        status: (response as { isError?: boolean } | undefined)?.isError ? "error" : "success",
      }, ctx.root);

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
      }, ctx.root);

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

  const cleanup = () => {
    for (const ctx of workspaceContextCache.values()) {
      try {
        ctx.watcher.close();
        ctx.db.close();
      } catch (err) {
        // Ignore close error during shutdown
      }
    }
    console.error("[Septum MCP] All database connections closed cleanly.");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("beforeExit", () => {
    for (const ctx of workspaceContextCache.values()) {
      try {
        ctx.watcher.close();
        ctx.db.close();
      } catch {
        // Ignore close error
      }
    }
  });

  await server.connect(transport);
  if (process.stdin.isTTY) {
    console.error(
      `\x1b[36m[Septum MCP]\x1b[0m Server daemon running on stdio (PID: ${process.pid}, v${SEPTUM_VERSION}).`
    );
    console.error(
      `\x1b[36m[Septum MCP]\x1b[0m Listening for JSON-RPC client messages. Press Ctrl+C to terminate.`
    );
  } else {
    console.error(`[Septum MCP] Server started successfully on stdio transport (v${SEPTUM_VERSION}).`);
  }
}
