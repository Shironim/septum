# Septum

> **Deterministic Bounded-Context & Anti-Poisoning Architecture Guard for AI Coding Agents.**

[![Version: 0.1.7](https://img.shields.io/badge/Version-0.1.7-blue)](package.json)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![Database: SQLite WAL](https://img.shields.io/badge/Database-SQLite%20(bun:sqlite)-003B57?logo=sqlite)](https://sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

Septum helps AI coding agents navigate code and respect declared architectural boundaries. It indexes your codebase into an embedded SQLite SSOT (`.septum/septum.db`), enforces strict bounded-context domains, and intercepts unauthorized cross-domain edits before they hit disk.

---

## Installation

Install Septum globally using [Bun](https://bun.sh):

```bash
bun add -g septum
```

> **Note:** You can also run commands on-the-fly without global installation using `bunx septum <command>`.

---

## Quick Start

### 1. Initialize in Any Project

```bash
septum init
# or zero-install via bunx:
bunx septum init
```
*Auto-detects project topology (Monorepos, Laravel, Next.js, Go, NestJS), registers domains, and ingests AST symbols into `.septum/septum.db`.*

### 2. Connect to AI Agent (MCP Server)

Add Septum to your MCP client (`mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "septum": {
      "command": "septum",
      "args": ["serve"]
    }
  }
}
```
*(Or use `"command": "bunx", "args": ["septum", "serve"]` if running without global installation).*

---

## CLI Reference

| Command | Description |
|---|---|
| `septum init` | Detect topology, scaffold boundary guards, and build initial catalog |
| `septum ingest` | Full AST re-indexing into `.septum/septum.db` |
| `septum sync` | Incremental synchronization of modified files for modified files |
| `septum check --strict` | CI/CD gate: verify boundary integrity & fail on violations |
| `septum query [domain]` | Inspect domain catalog, archetypes, and public signatures |
| `septum locate <query>` | Locate symbol, class, interface, method, or error source |
| `septum slice <route\|intent>` | Trace end-to-end vertical execution slice for route/intent |
| `septum topology [action]` | Inspect 6-layer environment topology plane & distributed nodes |
| `septum feature status\|clear` | Manage active feature lease and editing scope |
| `septum serve` | Launch stdio MCP server for AI coding agents |

---

## Core Capabilities & MCP Tools

All tools expose typed schemas automatically via the Model Context Protocol:

- **Self-Aware Environment Topology (`septum_get_environment_topology`):** Maps and verifies the 6-layer production architecture (Edge/WAF, Gateway/Web Server, Host, Runtime, Storage/Cache, Telemetry) and distributed entities with cross-layer invariants.
- **Whole-Project Telescope (`septum_get_domain_catalog`):** Returns macro architecture maps in < 400 tokens.
- **Omni-Trigger Vertical Slice Tracer (`septum_trace_vertical_slice`):** Traces execution chains across HTTP routes, queue jobs, console commands, and event listeners (*Ingress ➔ Validation ➔ Orchestration ➔ Domain ➔ Egress*).
- **Pre-Flight Boundary Guard (`septum_check_boundary`):** Validates proposed edits and imports against bounded-context rules.
- **Scope Locking (`septum_get_feature_context` / `septum_clear_feature_context`):** Locks active feature scope to eliminate context drift.
- **Symbol & Blast Radius (`septum_locate_symbol`, `septum_get_symbol`, `septum_get_symbol_impact`):** Resolves call chains, signatures, and refactoring impact.
- **God Function & Nesting Detector (`septum_get_symbol_hotspots`):** Surfaces oversized functions/methods ranked by physical lines, cyclomatic nesting depth, and composite risk score.
- **Dynamic Topology (`septum_register_domain`):** Registers or updates domains and boundary rules on-the-fly.

---

## Development & Contributing

```bash
# Clone and install dependencies
git clone https://github.com/shironim/septum.git
cd septum
bun install

# Run test suite & build
bun test
bun run build
```

---

## License

[MIT](LICENSE) © shironim

## Reliability and Scope

`septum check --strict` enables strict dependency rules before evaluating the codebase. A full check synchronizes the index first. CLI and MCP staged checks read Git index blobs, so unstaged edits cannot hide a violation in the proposed commit. Staged checks also evaluate dependency cycles using indexed dependencies with staged imports overlaid.

Domain ownership uses the most specific normalized root in both full and single-file ingestion. Feature touchpoints are normalized against the workspace; `/*` permits immediate children and `/**` permits descendants.

Each active MCP workspace has a watcher. Changes to multiple files are batched without dropping earlier paths; deletion and directory moves reconcile the catalog. If a native watcher is unavailable, Septum falls back to polling and synchronizes before answering queries. Catalog responses expose `index_status.watcher_mode` and `index_status.unsupported_files`. Single-file updates invalidate cached execution slices; the next trace rebuilds them.

Tree-sitter grammars are runtime dependencies and are embedded in compiled executables. The active extractors cover TypeScript/JavaScript, PHP/Blade, Python, Go, and script extraction from Vue/Svelte/Astro. Rust, Java, C#, and Ruby do not yet have active extractors. Unsupported files are reported explicitly; an incomplete audit does not receive a clean approval. Unindexed symbols return `risk_level: "unknown"`.

Feature sessions have a single owner per workspace. The default owner is the MCP process; set `SEPTUM_SESSION_ID` when several commands intentionally share the same owner. Another owner cannot replace or release the active session. Use `septum feature clear --force` for explicit recovery after a process exits or for a legacy session without ownership metadata.

Run the real-server integration checks with Python 3:

```bash
bun run test:integration
```

These checks exercise live rule changes, Git staged blobs, multiple workspaces, rapid edits, directory moves, and unsupported-file diagnostics. The normal `bun test` suite includes a standalone-binary regression for forbidden multiline imports.
