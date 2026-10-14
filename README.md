# Septum

> **Deterministic Bounded-Context & Anti-Poisoning Architecture Guard for AI Coding Agents.**

[![Version: 0.1.8](https://img.shields.io/badge/Version-0.1.8-blue)](package.json)
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

Run `septum init` in your project root:

```bash
septum init
# or zero-install via bunx:
bunx septum init
```

Septum automatically:
1. **Detects Architecture & Topology:** Discovers bounded domains across Monorepos, Laravel, Next.js, Go, NestJS, and more.
2. **Builds AST Symbol SSOT:** Ingests symbols, interfaces, and dependencies into `.septum/septum.db`.
3. **Scaffolds AI Agent Harnesses:** Interactively configures MCP servers, guardrail rules, and pre-write boundary hooks for your favorite agent environments:
   - **Claude Code** (`.mcp.json`, `.claude/settings.json`)
   - **Antigravity** (`.gemini/`)
   - **Cursor** (`.cursor/mcp.json`, `.cursor/hooks.json`)
   - **Opencode** (`opencode.json`)

### 2. Manual MCP Client Configuration (Optional)

If your MCP client is not configured via `septum init`, add Septum manually (`mcp.json` or `claude_desktop_config.json`):

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
| `septum check [--strict] [--staged] [--feature <name>] [--json]` | CI/CD gate & pre-commit hook: verify boundary integrity & fail on cross-domain violations |
| `septum feature [status|clear] [--force]` | View or release active feature lease and editing scope (`--force` for other owner's session) |
| `septum hook [subhook]` | Internal pre-tool guardrail hook (e.g. pre-write, post-write) for AI agent tools |
| `septum topology [subcommand]` | Inspect 6-layer environment topology plane & distributed nodes (`env` alias available). Subcommands: `resolve <layer> <platform>`, `add-node`, `remove-node`, `clear` |
| `septum serve` | Launch stdio MCP server for AI coding agents |

---

## Core Capabilities & MCP Tools

All tools expose typed schemas automatically via the Model Context Protocol:

- **Domain Catalog, Registration & Environment Topology (`septum_domain`):**
  - `action: "catalog"`: Whole-project macro architecture map and file connections in < 400 tokens (`detail_level: "compact" | "full"`).
  - `action: "register"`: Dynamically registers or updates bounded-context domains with allowed/forbidden dependencies and layer archetypes.
  - `action: "topology"`: Maps and verifies the 6-layer production architecture (Edge/WAF, Gateway/Web Server, Host, Runtime, Storage/Cache, Telemetry) and distributed nodes with cross-layer invariants.
- **Unified Symbol Engine (`septum_symbol`):**
  - `action: "locate"`: Fast fuzzy search and error log resolution to pinpoint symbols across workspaces.
  - `action: "inspect"`: Deep inspection of physical coordinates, declarations, and full typed signatures.
  - `action: "impact"`: Refactoring blast radius, call graphs, and inbound/outbound dependency analysis.
  - `action: "hotspots"`: God function and Single Responsibility Principle (SRP) detector ranked by physical lines, cyclomatic nesting depth, and composite risk score.
- **Omni-Trigger Vertical Slice Tracer (`septum_slice`):**
  - Traces end-to-end execution flow (*Ingress ➔ Validation ➔ Controller ➔ Service ➔ Repository ➔ Entity*) from route URIs, controller actions, or high-level intent across HTTP routes, queue jobs, console commands, and events up to 8 levels deep.
- **Architecture Guard & Circular Dependency Gate (`septum_boundary`):**
  - Validates proposed edits, additions, and imports against domain rules and feature touchpoints before files are modified on disk (`scope: "file"`).
  - Audits staged files (`scope: "staged"`), domain boundaries (`scope: "domain"`), or the entire repository (`scope: "all"`) for cross-domain leaks and dependency cycles.
- **Active Touchpoint & Scope Lock Engine (`septum_feature`):**
  - Locks active feature task context, touchpoints, and contracts (`action: "lock"` / `action: "get"` / `action: "release"`) via `.septum/session.json` to eliminate AI context drift and unintended edits.

---

## License

[MIT](LICENSE) © shironim

