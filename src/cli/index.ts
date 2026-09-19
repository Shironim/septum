import { SessionManager } from "../core/session/session-manager.ts";
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
  const args = argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    console.log("Septum v0.1.0");
    return;
  }

  try {
    switch (command) {
      case "init": {
        const force = args.includes("--force") || args.includes("-f");
        await handleInitCommand(force);
        break;
      }

      case "ingest": {
        await handleIngestCommand();
        break;
      }

      case "sync": {
        const json = args.includes("--json");
        await handleSyncCommand({ json });
        break;
      }

      case "query": {
        const domainName = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
        let archetype: string | undefined;
        const archIndex = args.indexOf("--archetype");
        if (archIndex !== -1 && args[archIndex + 1]) {
          archetype = args[archIndex + 1];
        }
        const jsonOutput = args.includes("--json");
        await handleQueryCommand(domainName, archetype, jsonOutput);
        break;
      }

      case "locate": {
        const query = args[1];
        if (!query) {
          console.error("Usage: septum locate <symbol-or-error> [--domain <domain>] [--json]");
          process.exit(1);
        }
        let domain: string | undefined;
        const domIndex = args.indexOf("--domain");
        if (domIndex !== -1 && args[domIndex + 1]) {
          domain = args[domIndex + 1];
        }
        const json = args.includes("--json");
        await handleLocateCommand(query, { domain, json });
        break;
      }

      case "slice": {
        const query = args[1];
        if (!query) {
          console.error("Usage: septum slice <route-or-intent> [--json]");
          process.exit(1);
        }
        const json = args.includes("--json");
        await handleSliceCommand(query, { json });
        break;
      }

      case "check": {
        const strict = args.includes("--strict");
        const staged = args.includes("--staged");
        let feature: string | undefined;
        const featIndex = args.indexOf("--feature");
        if (featIndex !== -1 && args[featIndex + 1]) {
          feature = args[featIndex + 1];
        }
        await handleCheckCommand({ strict, staged, feature });
        break;
      }

      case "serve": {
        await handleServeCommand();
        break;
      }

      case "feature": {
        const sub = args[1];
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
        await handleHookCommand(args);
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
Version: 0.1.0

USAGE:
  septum <command> [options]

COMMANDS:
  init                  Initialize configuration, gitignore, pre-commit hook, and ingest catalog
                        Options:
                          --force, -f           Overwrite existing catalog and configuration
  ingest                Scan codebase, parse AST, and synchronize .septum/septum.db
  sync                  Fast incremental synchronization of changed files to SQLite SSOT
                        Options:
                          --json                Output formatted JSON metrics
  query [domain]        Query structural catalog for a domain or list all domains
                        Options:
                          --archetype <name>    Filter by archetype (service, model, controller)
                          --json                Output formatted JSON
  check                 Audit codebase for cross-domain boundary violations
                        Options:
                          --staged              Audit only git staged changes (ideal for pre-commit)
                          --feature <name>      Enforce feature-specific allowed_touchpoints
                          --strict              Exit with code 1 on any violation
  feature [status|clear] View or release active feature context session lock
  serve                 Start Model Context Protocol (MCP) server over stdio

FLAGS:
  -h, --help            Show this help message
  -v, --version         Show current version
`);
}
