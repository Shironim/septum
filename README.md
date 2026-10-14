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
| `septum init [--force]` | Detect topology, scaffold boundary guards, and build initial catalog. `--force` regenerates Septum-owned hooks and harness artifacts while strictly preserving SQLite DB, manual domain policies, and user Git hooks |
| `septum sync [--json]` | AST synchronization and catalog update into `.septum/septum.db` (full or incremental) |
| `septum check --strict` | CI/CD gate: verify boundary integrity & fail on violations (`--staged` for git pre-commit) |
| `septum feature [status|clear]` | View or release active feature lease and editing scope (`--force` for other owner's session) |
| `septum hook [subhook]` | Internal pre-tool guardrail hook (e.g. pre-write) for AI agent tools |
| `septum topology [action]` | Inspect 6-layer environment topology plane & distributed nodes (`env` alias available) |
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

