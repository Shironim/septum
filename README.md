# Septum

> **Deterministic Bounded-Context & Anti-Poisoning Architecture Guard for AI Coding Agents.**

[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![Database: SQLite WAL](https://img.shields.io/badge/Database-SQLite%20(bun:sqlite)-003B57?logo=sqlite)](https://sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

Septum stops **context poisoning** in AI coding agents. It indexes your codebase into an embedded SQLite SSOT (`.septum/septum.db`), enforces strict bounded-context domains, and intercepts unauthorized cross-domain edits before they hit disk.

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
| `septum sync` | Fast incremental delta sync (< 15ms) for modified files |
| `septum check --strict` | CI/CD gate: verify boundary integrity & fail on violations |
| `septum query [domain]` | Inspect domain catalog, archetypes, and public signatures |
| `septum feature status\|clear` | Manage active feature lease and editing scope |
| `septum serve` | Launch stdio MCP server for AI coding agents |

---

## Core Capabilities & MCP Tools

All tools expose typed schemas automatically via the Model Context Protocol:

- **Whole-Project Telescope (`septum_get_domain_catalog`):** Returns macro architecture maps in < 400 tokens.
- **Vertical Slice Tracer (`septum_trace_vertical_slice`):** Traces execution chains (*Ingress ➔ Validation ➔ Orchestration ➔ Domain ➔ Egress*) across frameworks.
- **Pre-Flight Boundary Guard (`septum_check_boundary`):** Validates proposed edits and imports against bounded-context rules.
- **Scope Locking (`septum_get_feature_context` / `septum_clear_feature_context`):** Locks active feature scope to eliminate context drift.
- **Symbol & Blast Radius (`septum_locate_symbol`, `septum_get_symbol`, `septum_get_symbol_impact`):** Resolves call chains, signatures, and refactoring impact.
- **God Function Detector (`septum_get_symbol_hotspots`):** Surfaces oversized functions/methods by physical lines-of-code.
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
