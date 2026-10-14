import * as fs from "node:fs";
import * as path from "node:path";
import { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { ASTParserEngine } from "../../core/parser/tree-sitter.ts";
import { SessionManager } from "../../core/session/session-manager.ts";

interface ToolCallInfo {
  name?: string;
  args?: Record<string, unknown>;
}

export interface ToolPayload {
  tool_name?: string;
  toolCall?: ToolCallInfo;
  tool_input?: {
    TargetFile?: string;
    file_path?: string;
    filePath?: string;
    path?: string;
    ReplacementContent?: string;
    CodeContent?: string;
    new_string?: string;
    content?: string;
    ReplacementChunks?: Array<{ ReplacementContent?: string }>;
    feature_key?: string;
  };
  arguments?: Record<string, unknown>;
  TargetFile?: string;
  file_path?: string;
  filePath?: string;
  path?: string;
  ReplacementContent?: string;
  CodeContent?: string;
}

let configuredExitCode = 1;

export async function handleHookCommand(args: string[]): Promise<void> {
  const subHook = args[1] || "pre-write";
  if (args.includes("--exit-code-2") || args.includes("--claude") || args.includes("--cursor")) {
    configuredExitCode = 2;
  }

  if (subHook === "pre-write") {
    await runPreWriteHook();
  } else {
    process.exit(0);
  }
}

function blockHook(db: SeptumDatabase | null, reason: string): never {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  // Print readable error to stderr for humans and Claude/Cursor/Codex
  console.error(reason);

  // Print JSON contract to stdout for Antigravity hook engine
  try {
    process.stdout.write(
      JSON.stringify({
        decision: "deny",
        reason: reason.trim(),
      }) + "\n"
    );
  } catch {
    // ignore
  }

  // Exit code: 1 by default (Unix standard), or 2 if specified for Claude Code / Cursor hooks
  process.exit(configuredExitCode);
}

async function runPreWriteHook(): Promise<void> {
  // If .septum/septum.db does not exist, pass through
  const dbPath = path.resolve(process.cwd(), ".septum", "septum.db");
  if (!fs.existsSync(dbPath)) {
    process.exit(0);
  }

  // Read JSON payload from stdin
  const stdinData = await readStdin();
  if (!stdinData.trim()) {
    process.exit(0);
  }

  let payload: ToolPayload;
  try {
    payload = JSON.parse(stdinData);
  } catch {
    // Non-JSON stdin, pass through
    process.exit(0);
  }

  const toolInput: Record<string, any> =
    payload.tool_input ||
    payload.arguments ||
    payload.toolCall?.args ||
    (payload as Record<string, any>) ||
    {};
  const targetFile: string | undefined =
    toolInput.TargetFile || toolInput.file_path || toolInput.filePath || toolInput.path;
  const chunkContent = Array.isArray(toolInput.ReplacementChunks)
    ? toolInput.ReplacementChunks.map((c: any) => c?.ReplacementContent || "").join("\n")
    : "";
  const content: string =
    toolInput.ReplacementContent ||
    toolInput.CodeContent ||
    toolInput.new_string ||
    toolInput.content ||
    chunkContent ||
    "";

  if (!targetFile) {
    process.exit(0);
  }

  const config = ConfigLoader.load();
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo);

  try {
    const sourceDomain = evaluator.resolveSourceDomain(targetFile, config);

    // If file is not inside any domain, allow or check feature scope
    if (sourceDomain) {
      // -------------------------------------------------------------
      // GATE 3: Mandatory Catalog Consultation
      // Verify that the AI has consulted the domain catalog before writing
      // -------------------------------------------------------------
      const accessLogPath = path.resolve(process.cwd(), ".septum/catalog_access.json");
      let hasConsulted = false;

      if (fs.existsSync(accessLogPath)) {
        try {
          const rawAccess = JSON.parse(fs.readFileSync(accessLogPath, "utf-8"));
          const domainsMap: Record<string, string> = rawAccess.domains || {};
          const lowerSource = sourceDomain.toLowerCase();
          const domainAccessedAt =
            domainsMap[sourceDomain] ||
            domainsMap[lowerSource] ||
            Object.entries(domainsMap).find(([k]) => k.toLowerCase() === lowerSource)?.[1];
          if (domainAccessedAt) {
            hasConsulted = true;
          }
        } catch {
          // ignore parse error
        }
      }

      if (!hasConsulted) {
        blockHook(
          db,
          `\n[SEPTUM GATE 3 VIOLATION - Mandatory Consultation Required]\n` +
            `✕ Operation blocked: You are attempting to write to domain '${sourceDomain}' (${targetFile}) ` +
            `without inspecting its authoritative symbol & file-connection catalog first.\n` +
            `▶ REQUIRED ACTION: Call tool 'septum_domain({ action: "catalog", domain: "${sourceDomain}", detail_level: "compact" })' ` +
            `or 'septum_feature({ action: "get" })' before writing code.\n`
        );
      }
    }

    // -------------------------------------------------------------
    // GATE 1: Hard Touchpoint Lock (if features are defined)
    // -------------------------------------------------------------
    const session = SessionManager.getActiveSession(process.cwd());
    const requestedFeatureKey = toolInput.feature_key || process.env.SEPTUM_ACTIVE_FEATURE;
    if (session && requestedFeatureKey && requestedFeatureKey !== session.feature_key) {
      throw new Error(`Requested feature '${requestedFeatureKey}' does not own the active scope '${session.feature_key}'.`);
    }
    const activeFeatureKey = session?.feature_key || requestedFeatureKey;

    if (activeFeatureKey) {
      const touchpointViolations = evaluator.checkFeatureTouchpoints(
        activeFeatureKey,
        targetFile,
        config
      );

      if (touchpointViolations.length > 0) {
        blockHook(
          db,
          `\n[SEPTUM GATE 1 VIOLATION - Scope Touchpoint Lock]\n` +
            `✕ Operation blocked: File '${targetFile}' is outside the declared allowed_touchpoints for feature '${activeFeatureKey}'.\n` +
            `▶ REASON: ${touchpointViolations[0].message}\n` +
            `▶ REQUIRED ACTION: Only modify files declared in allowed_touchpoints for this feature.\n`
        );
      }
    }

    // -------------------------------------------------------------
    // GATE 2: Real-time AST Import Interception
    // Extract imports from proposed content and check for boundary leaks
    // -------------------------------------------------------------
    if (content && sourceDomain) {
      const astEngine = new ASTParserEngine();
      const parsed = await astEngine.parseFile(targetFile, content);
      if (ASTParserEngine.isSourceFile(targetFile) && (parsed.status === "unsupported" || parsed.status === "degraded")) {
        throw new Error(`Cannot reliably check imports in '${targetFile}': parser status is ${parsed.status}.`);
      }

      const proposedImports = parsed.dependencies.map((d) => d.target);
      const boundaryViolations = evaluator.checkProposedChanges(
        targetFile,
        proposedImports,
        config
      );

      if (boundaryViolations.length > 0) {
        const v = boundaryViolations[0];
        blockHook(
          db,
          `\n[SEPTUM GATE 2 VIOLATION - Forbidden Cross-Domain Import]\n` +
            `✕ Operation blocked: Proposed code imports forbidden domain '${v.target_domain}' from '${v.source_domain}'.\n` +
            `▶ OFFENDING IMPORT: ${v.imported_target}\n` +
            `▶ RULE: ${v.rule}\n` +
            `▶ MESSAGE: ${v.message}\n` +
            `▶ REQUIRED ACTION: Decouple this dependency. Use an authorized Interface, Event, or Shared Kernel.\n`
        );
      }
    }

    db.close();

    // If running in Antigravity or standard JSON IPC mode, emit allow decision
    try {
      process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    } catch {
      // ignore
    }
    process.exit(0);
  } catch (err) {
    db.close();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[Septum Hook Error]\x1b[0m ${message}`);
    process.exit(1);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", () => {
      resolve("");
    });
  });
}
