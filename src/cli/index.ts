import { parseArgs } from "node:util";
import { SessionManager } from "../core/session/session-manager.ts";
import { SEPTUM_VERSION } from "../version.ts";
import { handleCheckCommand } from "./commands/check.ts";
import { handleHookCommand } from "./commands/hook.ts";
import { handleIngestCommand } from "./commands/ingest.ts";
import { handleInitCommand } from "./commands/init.ts";
import { handleLocateCommand } from "./commands/locate.ts";
import { handleQueryCommand } from "./commands/query.ts";
import { handleServeCommand } from "./commands/serve.ts";
import { handleSliceCommand } from "./commands/slice.ts";
import { handleSyncCommand } from "./commands/sync.ts";

export async function runCLI(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(2),
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        force: { type: "boolean", short: "f" },
        json: { type: "boolean" },
        strict: { type: "boolean" },
        staged: { type: "boolean" },
        domain: { type: "string", short: "d" },
        archetype: { type: "string", short: "a" },
        feature: { type: "string" },
      },
      allowPositionals: true,
      strict: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[Septum Error]\x1b[0m ${message}`);
    process.exit(1);
  }

  const { values: flags, positionals } = parsed;
  const command = positionals[0];

  if (flags.version || command === "version") {
    console.log(`Septum v${SEPTUM_VERSION}`);
    return;
  }

  if (flags.help || !command || command === "help") {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case "init": {
        const force = Boolean(flags.force);
        await handleInitCommand(force);
        break;
      }

      case "ingest": {
        await handleIngestCommand();
        break;
      }

      case "sync": {
        const json = Boolean(flags.json);
        await handleSyncCommand({ json });
        break;
      }

      case "query": {
        const domainName = positionals[1];
        const archetype = typeof flags.archetype === "string" ? flags.archetype : undefined;
        const jsonOutput = Boolean(flags.json);
        await handleQueryCommand(domainName, archetype, jsonOutput);
        break;
      }

      case "locate": {
        const query = positionals[1];
        if (!query) {
          console.error("Usage: septum locate <symbol-or-error> [--domain <domain>] [--json]");
          process.exit(1);
        }
        const domain = typeof flags.domain === "string" ? flags.domain : undefined;
        const json = Boolean(flags.json);
        await handleLocateCommand(query, { domain, json });
        break;
      }

      case "slice": {
        const query = positionals[1];
        if (!query) {
          console.error("Usage: septum slice <route-or-intent> [--json]");
          process.exit(1);
        }
        const json = Boolean(flags.json);
        await handleSliceCommand(query, { json });
        break;
      }

      case "check": {
        const strict = Boolean(flags.strict);
        const staged = Boolean(flags.staged);
        const feature = typeof flags.feature === "string" ? flags.feature : undefined;
        await handleCheckCommand({ strict, staged, feature });
        break;
      }

      case "serve": {
        await handleServeCommand();
        break;
      }

      case "feature": {
        const sub = positionals[1];
        if (sub === "clear") {
          const cleared = SessionManager.clearActiveSession(process.cwd());
          if (cleared) {
            console.log("✓ Active feature session successfully cleared.");
          } else {
            console.log("ℹ No active feature session found.");
          }
        } else if (sub === "status" || !sub) {
          const current = SessionManager.getActiveSession(process.cwd());
          if (current) {
            console.log(`\nActive Feature Session:`);
            console.log(`▶ Feature Key : ${current.feature_key}`);
            console.log(`▶ Domain      : ${current.domain}`);
            console.log(`▶ Locked At   : ${current.locked_at}`);
            console.log(`▶ Touchpoints : ${current.touchpoints.join(", ")}\n`);
          } else {
            console.log("ℹ No active feature session. All domain files accessible according to boundary rules.");
          }
        } else {
          console.error(`Unknown feature subcommand: '${sub}'. Use 'status' or 'clear'.`);
          process.exit(1);
        }
        break;
      }

      case "hook": {
        await handleHookCommand(argv.slice(2));
        break;
      }

      default: {
        console.error(`[Septum] Unknown command: '${command}'`);
        console.error("Run 'septum --help' for available commands.");
        process.exit(1);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m[Septum Error]\x1b[0m ${message}`);
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
Septum — Deterministic Bounded-Context & Structural File Catalog
Version: v${SEPTUM_VERSION}

USAGE:
  septum <command> [options]
  septum [flags]

COMMANDS:
  Catalog & Ingestion:
    init                  Initialize configuration, gitignore, pre-commit hook, and catalog
                          Flags: -f, --force
    ingest                Full AST scan and synchronization to SQLite database
    sync                  Incremental fast synchronization of modified files
                          Flags: --json

  Structural Discovery:
    query [domain]        Query structural catalog for a domain or whole project
                          Flags: -a, --archetype <name>, --json
    locate <query>        Locate symbol, class, interface, method, or error source
                          Flags: -d, --domain <name>, --json
    slice <route|intent>  Trace end-to-end vertical execution slice for route/intent
                          Flags: --json

  Boundary & Enforcement:
    check                 Audit codebase for cross-domain boundary violations
                          Flags: --strict, --staged, --feature <name>
    feature [status|clear] View or release active feature context session lock
    hook [subhook]        Internal pre-tool guardrail hook (e.g. pre-write)

  Daemon & Protocol:
    serve                 Start Model Context Protocol (MCP) server over stdio

GLOBAL FLAGS:
  -h, --help              Show this help message
  -v, --version           Show current version
  --json                  Output formatted JSON metrics / results
`);
}
