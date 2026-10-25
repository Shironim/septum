import { parseArgs } from "node:util";
import { SessionManager } from "../core/session/session-manager.ts";
import { SEPTUM_VERSION, checkRuntimeVersion, formatUpdateNotice, type RuntimeVersionMeta } from "../utils/version-check.ts";
import { handleCheckCommand } from "./commands/check.ts";
import { handleHookCommand } from "./commands/hook.ts";
import { handleInitCommand } from "./commands/init.ts";
import { handleTopologyCommand } from "./commands/topology.ts";
import { handleServeCommand } from "./commands/serve.ts";
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
    const meta = await checkRuntimeVersion({ timeoutMs: 1200 });
    const notice = formatUpdateNotice(meta);
    if (notice) {
      console.log(notice);
    }
    return;
  }

  if (flags.help || !command || command === "help") {
    const meta = await checkRuntimeVersion({ timeoutMs: 1000 });
    printHelp(meta);
    return;
  }

  try {
    switch (command) {
      case "init": {
        const force = Boolean(flags.force);
        await handleInitCommand(force);
        break;
      }

      case "sync": {
        const json = Boolean(flags.json);
        await handleSyncCommand({ json });
        break;
      }

      case "check": {
        const strict = Boolean(flags.strict);
        const staged = Boolean(flags.staged);
        const feature = typeof flags.feature === "string" ? flags.feature : undefined;
        const json = Boolean(flags.json);
        await handleCheckCommand({ strict, staged, feature, json });
        break;
      }

      case "serve": {
        await handleServeCommand();
        break;
      }

      case "topology":
      case "env": {
        await handleTopologyCommand(positionals[1], positionals[2], positionals[3], positionals[4], positionals[5]);
        break;
      }

      case "feature": {
        const sub = positionals[1];
        if (sub === "clear") {
          const cleared = SessionManager.clearActiveSession(process.cwd(), undefined, Boolean(flags.force));
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

function printHelp(versionMeta?: RuntimeVersionMeta): void {
  const notice = versionMeta ? formatUpdateNotice(versionMeta) : null;
  console.log(`
Septum — Deterministic Bounded-Context & Structural File Catalog
Version: v${SEPTUM_VERSION}${notice ? `\n\n${notice}` : ""}

USAGE:
  septum <command> [options]
  septum [flags]

COMMANDS:
  Core Lifecycle & Indexing:
    init                  Initialize configuration, gitignore, pre-commit hook, and catalog
                          Flags: -f, --force (regenerate Septum-owned hooks & harness artifacts; preserves DB, domain policies, and user hooks)
    sync                  Codebase AST synchronization and catalog update (full or incremental)
                          Flags: --json

  Boundary & Enforcement:
    check                 Audit codebase for cross-domain boundary violations
                          Flags: --strict, --staged, --feature <name>, --json
    feature [status|clear] View or release active feature context session lock
                          Flags: --force (explicit recovery of another owner's session)
    hook [subhook]        Internal pre-tool guardrail hook (e.g. pre-write)

  Environment & Topology:
    topology, env [action] Inspect 6-layer environment topology & distributed nodes
                          Subcommands: resolve <layer> <platform>, add-node, remove-node, clear

  Daemon & Protocol:
    serve                 Start Model Context Protocol (MCP) server over stdio

GLOBAL FLAGS:
  -h, --help              Show this help message
  -v, --version           Show current version
`);
}
