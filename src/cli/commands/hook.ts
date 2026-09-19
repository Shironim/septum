import * as fs from "node:fs";
import * as path from "node:path";
import { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { ASTParserEngine } from "../../core/parser/tree-sitter.ts";
import { SessionManager } from "../../core/session/session-manager.ts";

export interface ToolPayload {
  tool_name: string;
  tool_input: {
    TargetFile?: string;
    file_path?: string;
    ReplacementContent?: string;
    CodeContent?: string;
    feature_key?: string;
  };
}

export async function handleHookCommand(args: string[]): Promise<void> {
  const subHook = args[1] || "pre-write";

  if (subHook === "pre-write") {
    await runPreWriteHook();
  } else {
    process.exit(0);
  }
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

  const toolInput = payload.tool_input || {};
  const targetFile = toolInput.TargetFile || toolInput.file_path;
  const content = toolInput.ReplacementContent || toolInput.CodeContent || "";

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
          const domainAccessedAt = rawAccess.domains?.[sourceDomain];
          if (domainAccessedAt) {
            hasConsulted = true;
          }
        } catch {
          // ignore parse error
        }
      }

      if (!hasConsulted) {
        console.error(
          `\n[SEPTUM GATE 3 VIOLATION - Mandatory Consultation Required]\n` +
            `✕ Operation blocked: You are attempting to write to domain '${sourceDomain}' (${targetFile}) ` +
            `without inspecting its authoritative catalog first.\n` +
            `▶ REQUIRED ACTION: Call tool 'septum_get_domain_catalog(domain: "${sourceDomain}")' ` +
            `or 'septum_get_feature_context' before writing code.\n`
        );
        db.close();
        process.exit(1);
      }
    }

    // -------------------------------------------------------------
    // GATE 1: Hard Touchpoint Lock (if features are defined)
    // -------------------------------------------------------------
    const features = config.features ?? {};
    const session = SessionManager.getActiveSession(process.cwd());
    const activeFeatureKey =
      toolInput.feature_key || process.env.SEPTUM_ACTIVE_FEATURE || session?.feature_key;

    if (activeFeatureKey && features[activeFeatureKey]) {
      const touchpointViolations = evaluator.checkFeatureTouchpoints(
        activeFeatureKey,
        targetFile,
        config
      );

      if (touchpointViolations.length > 0) {
        console.error(
          `\n[SEPTUM GATE 1 VIOLATION - Scope Touchpoint Lock]\n` +
            `✕ Operation blocked: File '${targetFile}' is outside the declared allowed_touchpoints for feature '${activeFeatureKey}'.\n` +
            `▶ REASON: ${touchpointViolations[0].message}\n` +
            `▶ REQUIRED ACTION: Only modify files declared in allowed_touchpoints for this feature.\n`
        );
        db.close();
        process.exit(1);
      }
    }

    // -------------------------------------------------------------
    // GATE 2: Real-time AST Import Interception
    // Extract imports from proposed content and check for boundary leaks
    // -------------------------------------------------------------
    if (content && sourceDomain) {
      const astEngine = new ASTParserEngine();
      const parsed = await astEngine.parseFile(targetFile, content);

      const proposedImports = parsed.dependencies.map((d) => d.target);
      const boundaryViolations = evaluator.checkProposedChanges(
        targetFile,
        proposedImports,
        config
      );

      if (boundaryViolations.length > 0) {
        const v = boundaryViolations[0];
        console.error(
          `\n[SEPTUM GATE 2 VIOLATION - Forbidden Cross-Domain Import]\n` +
            `✕ Operation blocked: Proposed code imports forbidden domain '${v.target_domain}' from '${v.source_domain}'.\n` +
            `▶ OFFENDING IMPORT: ${v.imported_target}\n` +
            `▶ RULE: ${v.rule}\n` +
            `▶ MESSAGE: ${v.message}\n` +
            `▶ REQUIRED ACTION: Decouple this dependency. Use an authorized Interface, Event, or Shared Kernel.\n`
        );
        db.close();
        process.exit(1);
      }
    }

    db.close();
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
