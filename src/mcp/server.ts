import { WorkspaceManager, resolveServerWorkspace, isWorkspaceInitialized, type WorkspaceLease } from "./workspace-manager.ts";
import { RESOURCE_LIMITS } from "../core/resources/limits.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ConfigLoader } from "../core/config/loader.ts";
import { SessionManager } from "../core/session/session-manager.ts";
import { SeptumTelemetry } from "../core/telemetry/telemetry.ts";
import { handleDomainTool } from "./tools/domain.ts";
import { handleSymbolTool } from "./tools/symbol.ts";
import { handleSliceTool } from "./tools/slice.ts";
import { handleBoundaryTool } from "./tools/boundary.ts";
import { handleFeatureTool } from "./tools/feature.ts";

import {
  DomainToolSchema,
  SymbolToolSchema,
  SliceToolSchema,
  BoundaryToolSchema,
  FeatureToolSchema,
} from "./schemas.ts";
import { SEPTUM_VERSION } from "../version.ts";
import { checkRuntimeVersion } from "../utils/version-check.ts";

const TOOL_SCHEMAS = {
  septum_domain: DomainToolSchema,
  septum_symbol: SymbolToolSchema,
  septum_slice: SliceToolSchema,
  septum_boundary: BoundaryToolSchema,
  septum_feature: FeatureToolSchema,
};

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

function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

export async function runMCPServer(): Promise<void> {
  const manager = new WorkspaceManager();

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
          name: "septum_domain",
          description:
            "Domain Catalog, Registration & Environment Topology Engine. Manages macro architecture, domain topology, bounded-context registration, and infrastructure plane (Edge, Gateway, Host, Runtime, Storage, Telemetry). Token-efficient (< 400 tokens).",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["catalog", "register", "topology"],
                default: "catalog",
                description: "Sub-operation to execute: 'catalog' (inspect domain/macro map), 'register' (dynamically register bounded-context domain), or 'topology' (6-layer infrastructure plane).",
              },
              domain: {
                type: "string",
                description: "Target domain name (e.g. 'orders', 'core'). If omitted in catalog action, returns project-wide Macro Semantic Map.",
              },
              detail_level: {
                type: "string",
                enum: ["compact", "full"],
                default: "compact",
                description: "Catalog detail level: 'compact' (default, token-efficient summary with file connections) or 'full' (includes full signatures).",
              },
              archetype_filter: {
                type: "string",
                description: "Optional archetype filter (e.g. 'service', 'model', 'controller', 'repository').",
              },
              file_filter: {
                type: "string",
                description: "Optional substring filter to inspect specific file(s) within the domain.",
              },
              root: {
                type: "string",
                description: "Root directory path for domain registration (action='register').",
              },
              description: {
                type: "string",
                description: "Architectural purpose of the domain (action='register').",
              },
              allowed_dependencies: {
                type: "array",
                items: { type: "string" },
                description: "List of domain names this domain is allowed to import (action='register').",
              },
              forbidden_dependencies: {
                type: "array",
                items: { type: "string" },
                description: "List of domain names strictly forbidden from being imported (action='register').",
              },
              archetypes: {
                type: "object",
                description: "Layer archetypes mapping (action='register').",
              },
              ingest_now: {
                type: "boolean",
                default: false,
                description: "Whether to immediately run AST ingestion on domain files upon registration.",
              },
              resolve: {
                type: "object",
                properties: {
                  layer: {
                    type: "string",
                    enum: ["edge", "gateway", "host", "runtime", "storage", "telemetry"],
                  },
                  platform: { type: "string" },
                  constraints: { type: "array", items: { type: "string" } },
                },
                description: "Record and verify infrastructure layer in SQLite SSOT (action='topology').",
              },
              resolve_node: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  layer: { type: "string", enum: ["edge", "gateway", "host", "runtime", "storage", "telemetry"] },
                  name: { type: "string" },
                  platform: { type: "string" },
                  domain_or_ip: { type: "string" },
                  role: { type: "string" },
                  connected_to: { type: "array", items: { type: "string" } },
                  constraints: { type: "array", items: { type: "string" } },
                },
                description: "Record distributed topology node in SQLite SSOT (action='topology').",
              },
              refresh: {
                type: "boolean",
                description: "Force re-detection from codebase files, ignoring cached status (action='topology').",
              },
              workspace_path: {
                type: "string",
                description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
              },
            },
            required: [],
          },
        },
        {
          name: "septum_symbol",
          description:
            "Unified Symbol Engine: single entrypoint for symbol location, full contract inspection, refactoring blast radius (impact), and Single Responsibility / God Function complexity hotspots.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["locate", "inspect", "impact", "hotspots"],
                default: "locate",
                description: "Sub-operation: 'locate' (fuzzy search/error log resolution), 'inspect' (physical coordinates & signatures), 'impact' (blast radius & inbound callers), or 'hotspots' (complexity & SRP smells).",
              },
              query: {
                type: "string",
                description: "Symbol name, call syntax (e.g. 'OrderController::cancelOrder'), or search query (for locate, inspect, impact).",
              },
              domain: {
                type: "string",
                description: "Optional domain filter (e.g. 'orders').",
              },
              file_path: {
                type: "string",
                description: "Exact indexed repository-relative file path. Use it to select one candidate when names are ambiguous.",
              },
              symbol_ref: {
                type: "object",
                description: "Declaration reference returned by locate/inspect or a full catalog. Selects an overload for locate/inspect; stale indexed fingerprints are refused.",
                properties: {
                  file_path: { type: "string", minLength: 1 },
                  language: { type: "string", minLength: 1 },
                  name: { type: "string", minLength: 1 },
                  kind: { type: "string", minLength: 1 },
                  signature: { type: "string" },
                  start_line: { type: "integer", minimum: 1 },
                  end_line: { type: "integer", minimum: 1 },
                  indexed_content_hash: { type: "string", minLength: 1 },
                  container: { type: "string" },
                  receiver: { type: "string" },
                },
                required: ["file_path", "language", "name", "kind", "signature", "start_line", "end_line", "indexed_content_hash"],
              },
              include_source: {
                type: "boolean",
                default: false,
                description: "For action='inspect', include a bounded source slice only when the indexed file fingerprint still matches disk.",
              },
              source_start_line: {
                type: "number",
                minimum: 1,
                description: "First line to return within the selected symbol range (action='inspect').",
              },
              source_line_limit: {
                type: "number",
                minimum: 1,
                maximum: 200,
                default: 120,
                description: "Maximum source lines returned (action='inspect', capped at 200).",
              },
              include_dependencies: {
                type: "boolean",
                default: true,
                description: "Whether to include injected dependencies and outbound calls (action='inspect').",
              },
              min_lines: {
                type: "number",
                description: "Minimum physical lines of code threshold (action='hotspots', default: 30).",
              },
              min_nesting: {
                type: "number",
                description: "Minimum control-flow nesting depth threshold (action='hotspots').",
              },
              kind: {
                type: "string",
                description: "Filter symbol kind: 'function' | 'method' | 'class' | 'struct' | 'interface' (action='hotspots').",
              },
              sort_by: {
                type: "string",
                enum: ["risk_score", "line_count", "lines", "nesting"],
                default: "risk_score",
                description: "Sorting criteria for hotspots (action='hotspots').",
              },
              limit: {
                type: "number",
                description: "Maximum results to return (default: 10 for locate, 30 for hotspots).",
              },
              workspace_path: {
                type: "string",
                description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
              },
            },
            required: [],
          },
        },
        {
          name: "septum_slice",
          description:
            "Vertical Execution Slice Tracer: traces end-to-end execution flow (Ingress -> Validation -> Controller -> Service -> Repository -> Entity) from route URI, controller action, or high-level intent without guessing files.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Route URI (e.g. 'POST /orders/{id}/pay'), action (e.g. 'OrderController@pay'), or high-level task intent.",
              },
              max_depth: {
                type: "number",
                default: 5,
                minimum: 1,
                maximum: 8,
                description: "Maximum depth to trace (default: 5, min: 1, max: 8). Use 6-8 for deep Event/Job/Queue traces.",
              },
              workspace_path: {
                type: "string",
                description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "septum_boundary",
          description:
            "Architecture Guard & Circular Dependency Gate: Pre-flight boundary check verifying proposed file edits, additions, and imports against domain rules and feature touchpoints, or auditing the entire repository / staged files for cross-domain and circular dependencies.",
          inputSchema: {
            type: "object",
            properties: {
              scope: {
                type: "string",
                enum: ["file", "staged", "all", "domain"],
                description: "Audit scope: 'file' requires file_path or non-empty file_paths; 'staged', 'all', and 'domain' reject file targets and proposed_imports. 'domain' requires a registered domain; 'all' rejects domain filters. If omitted, infer file/staged/domain/all from arguments.",
              },
              file_path: {
                type: "string",
                description: "Path of the file being edited or created (scope='file' only). Use either file_path or file_paths.",
              },
              file_paths: {
                type: "array",
                items: { type: "string" },
                description: "Non-empty list of file paths for batch proposed-import checks (scope='file' only). Use either file_path or file_paths.",
              },
              proposed_imports: {
                type: "array",
                items: { type: "string" },
                description: "List of proposed import statements or target symbols (scope='file' only).",
              },
              domain: {
                type: "string",
                description: "Registered domain name, required for scope='domain'; optional for staged/file checks. Explicit scope='all' does not accept a domain filter.",
              },
              feature_key: {
                type: "string",
                description: "Optional feature key to validate touchpoints against.",
              },
              workspace_path: {
                type: "string",
                description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
              },
            },
            required: [],
          },
        },
        {
          name: "septum_feature",
          description:
            "Active Touchpoint & Scope Lock Engine: manages feature task context, touchpoint locks (.septum/session.json), and session release to enforce surgical blast-radius boundaries.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["get", "lock", "release"],
                default: "get",
                description: "Feature lifecycle action: 'get' (retrieve feature context), 'lock' (register feature & establish active session lease), or 'release' (release active session lock).",
              },
              feature_key: {
                type: "string",
                description: "Unique feature identifier (e.g. 'checkout_flow'). Symmetrically accepts 'feature'.",
              },
              domain: {
                type: "string",
                description: "Bounded-context domain for this feature (action='lock').",
              },
              description: {
                type: "string",
                description: "Scope and rationale for the feature (action='lock').",
              },
              allowed_touchpoints: {
                type: "array",
                items: { type: "string" },
                description: "Permitted file paths or glob patterns (action='lock').",
              },
              reuse_symbols: {
                type: "array",
                items: { type: "string" },
                description: "Mandatory reusable symbols (action='lock').",
              },
              input_contract: {
                type: "object",
                description: "Expected input payload / DTO schema (action='lock').",
              },
              output_contract: {
                type: "object",
                description: "Expected output response contract (action='lock').",
              },
              force: {
                type: "boolean",
                default: false,
                description: "Force release session (action='release').",
              },
              workspace_path: {
                type: "string",
                description: "Explicit workspace root path. Specifies the target project root in multi-root environments.",
              },
            },
            required: [],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const startTime = performance.now();
    let lease: WorkspaceLease | undefined;
    try {
    extra?.signal?.throwIfAborted();
    const schema = TOOL_SCHEMAS[name as keyof typeof TOOL_SCHEMAS];
    if (!schema) throw new Error(`Unknown tool: '${name}'`);
    const validated = schema.safeParse(args ?? {});
    if (!validated.success) throw new Error(`[Septum Validation Error] Invalid arguments for ${name}: ${validated.error.message}`);
    const record = (validated.data ?? {}) as Record<string, any>;
    const raw = (args ?? {}) as Record<string, any>;
    const workspacePath = record.workspace_path ?? raw.workspace_path ?? raw.workspacePath ?? raw.workspace ?? raw.project_root ?? raw.projectRoot;
    const knownRoots = manager.activeRoots;
    if (manager.initialRoot && !knownRoots.includes(manager.initialRoot)) {
      knownRoots.unshift(manager.initialRoot);
    }
    const fallbackRoot = manager.initialRoot || manager.lastRoot;
    const root = resolveServerWorkspace({
      workspacePath,
      filePath: workspacePath ? undefined : extractPathHint(args),
      fallbackRoot,
      knownRoots,
    });

    if (!isWorkspaceInitialized(root)) {
      if (name === "septum_domain" && (!record.action || record.action === "catalog")) {
        const runtimeVersion = await checkRuntimeVersion();
        let agentGuidance =
          "Panggil tool 'septum_domain(action: \"register\", name: \"core\", root: \"src\", ingest_now: true)' untuk mendaftarkan dan mengindeks domain utama secara otomatis, atau jalankan 'septum init' di terminal workspace.";
        if (runtimeVersion.update_available) {
          agentGuidance += ` Update available: v${runtimeVersion.server_version} -> v${runtimeVersion.latest_version}. Recommend running '${runtimeVersion.upgrade_command}' and reloading the MCP server if schema/features differ.`;
        }
        const diagnostic: Record<string, any> = {
          status: "NOT_INDEXED",
          total_domains: 0,
          runtime_version: runtimeVersion,
          message: `Workspace '${root}' belum diinisialisasi dengan Septum. Jalankan 'septum init' terlebih dahulu di terminal workspace.`,
          suggested_action: {
            tool: "septum_domain",
            params: {
              action: "register",
              name: "core",
              root: "src",
              ingest_now: true,
            },
          },
          agent_guidance: agentGuidance,
          ...(runtimeVersion.update_available
            ? {
                agent_instruction: `Update available: v${runtimeVersion.server_version} -> v${runtimeVersion.latest_version}. Recommend running '${runtimeVersion.upgrade_command}' and reloading the MCP server if schema/features differ.`,
              }
            : {}),
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(diagnostic, null, 2),
            },
          ],
          metadata: diagnostic,
          runtime_version: runtimeVersion,
        };
      }
      const isRegistration = name === "septum_domain" && record.action === "register";
      if (!isRegistration) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[Septum MCP Error] Workspace '${root}' belum diinisialisasi. Jalankan 'septum init' di terminal workspace atau gunakan tool 'septum_domain' dengan action='register' untuk mendaftarkan domain.`,
            },
          ],
        };
      }
    }

    extra?.signal?.throwIfAborted();
    lease = manager.acquire(root);
    const ctx = lease.context;
    await ctx.ready;
    extra?.signal?.throwIfAborted();
    await ctx.watcher.flush(true, extra?.signal);
    if (ctx.repo.getMeta("sync_error")) throw new Error(`Workspace index synchronization failed: ${ctx.repo.getMeta("sync_error")}`);
    ctx.config = ConfigLoader.load(undefined, ctx.root);
    ctx.evaluator.getResolver().setRepository(ctx.repo);

    let activeSession = null;
    let sessionCorruptError: Error | null = null;
    try {
      activeSession = SessionManager.getActiveSession(ctx.root);
    } catch (err: any) {
      sessionCorruptError = err instanceof Error ? err : new Error(String(err));
    }
    const sessionPayload = activeSession
      ? { feature_key: activeSession.feature_key, domain: activeSession.domain }
      : null;

    const executeTool = async () => {
      // 5 Unified Tools Handlers
      if (name === "septum_domain") {
        const parsed = DomainToolSchema.safeParse(args ?? {});
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
        return await handleDomainTool(ctx.repo, ctx.config, parsed.data, ctx.root, extra?.signal);
      } else if (name === "septum_symbol") {
        const parsed = SymbolToolSchema.safeParse(args ?? {});
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
        return await handleSymbolTool(ctx.repo, ctx.config, parsed.data, ctx.pipeline, ctx.root);
      } else if (name === "septum_slice") {
        const parsed = SliceToolSchema.safeParse(args ?? {});
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
        return handleSliceTool(ctx.repo, ctx.config, parsed.data, ctx.root, extra?.signal);
      } else if (name === "septum_boundary") {
        if (sessionCorruptError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Session Error] Active feature session in '.septum/session.json' is corrupted or invalid: ${sessionCorruptError.message}. Release it explicitly with 'septum_feature({action: "release", force: true})' before evaluating boundaries.`,
              },
            ],
          };
        }
        const parsed = BoundaryToolSchema.safeParse(args ?? {});
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
        return await handleBoundaryTool(ctx.evaluator, ctx.config, parsed.data, ctx.repo, ctx.root);
      } else if (name === "septum_feature") {
        const parsed = FeatureToolSchema.safeParse(args ?? {});
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
        if (sessionCorruptError && (parsed.data.action !== "release" || !parsed.data.force)) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[Septum Session Error] Active feature session in '.septum/session.json' is corrupted or invalid: ${sessionCorruptError.message}. Release it explicitly with 'septum_feature({action: "release", force: true})'.`,
              },
            ],
          };
        }
        extra?.signal?.throwIfAborted();
        return await handleFeatureTool(ctx.repo, ctx.config, parsed.data, ctx.root);
      } else {
        throw new Error(`Unknown tool: '${name}'`);
      }
    };

    try {
      const response = await manager.runTool(executeTool, extra?.signal);
      const durationMs = Math.round(performance.now() - startTime);

      let bytesOut = 0;
      let linesOut = 0;
      if (Array.isArray(response?.content)) {
        for (const item of response.content) {
          if (typeof item.text === "string") {
            bytesOut += Buffer.byteLength(item.text, "utf8");
            linesOut += countLines(item.text);
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
    } catch (error) {
      return {isError: true, content: [{type: "text" as const, text: `[Septum MCP Error] ${error instanceof Error ? error.message : String(error)}`}]};
    } finally { lease?.release(); }
  });

  const transport = new StdioServerTransport();

  let stopping = false;
  let memoryTimer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (stopping) return;
    stopping = true;
    if (memoryTimer) clearInterval(memoryTimer);
    const deadline = setTimeout(() => {
      console.error("[Septum MCP] Shutdown deadline exceeded; indexing may require reconciliation.");
      process.exit(1);
    }, RESOURCE_LIMITS.shutdownMs);
    void (async () => {
      try {
        await server.close();
        await manager.close();
        clearTimeout(deadline);
        console.error("[Septum MCP] All workspace resources closed cleanly.");
        process.exit(0);
      } catch (error) {
        console.error(`[Septum MCP] Cleanup failed: ${String(error)}`);
        clearTimeout(deadline);
        process.exit(1);
      }
    })();
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.stdin.once("end", cleanup);
  process.stdin.once("close", cleanup);
  server.onclose = cleanup;
  await server.connect(transport);
  try {
    const initialRoot = resolveServerWorkspace({initial:true});
    manager.initialRoot = initialRoot;
    manager.lastRoot = initialRoot;
    if (isWorkspaceInitialized(initialRoot)) {
      const initial = manager.acquire(initialRoot);
      try { await initial.context.ready; } finally { initial.release(); }
    }
    if (process.env.SEPTUM_MEMORY_DIAGNOSTICS === "1") {
      memoryTimer = setInterval(() => {
        const sample = { ...process.memoryUsage(), workspaces: manager.size, watches: manager.watchCount, pending_paths: manager.pendingPaths, sync_duration_ms: manager.syncDurationMs };
        if (manager.lastRoot && isWorkspaceInitialized(manager.lastRoot)) {
          SeptumTelemetry.recordMemorySample(sample, manager.lastRoot);
        } else {
          console.error(`[Septum Memory] ${JSON.stringify({timestamp: new Date().toISOString(), event: "memory_sample", metrics: sample})}`);
        }
      }, 60_000);
      memoryTimer.unref();
    }
  } catch (error) {
    await manager.close();
    throw error;
  }

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
