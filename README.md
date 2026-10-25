# Septum

> **Architecture boundary guard and codebase intelligence for AI coding agents.**

[![Version: 0.1.9](https://img.shields.io/badge/Version-0.1.9-blue)](package.json)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![Protocol: Model Context Protocol](https://img.shields.io/badge/Protocol-MCP-green)](https://modelcontextprotocol.io/)
[![Database: SQLite WAL](https://img.shields.io/badge/Database-SQLite%20(bun:sqlite)-003B57?logo=sqlite)](https://sqlite.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

Septum helps AI coding agents understand codebase architecture and respect modular boundaries. It parses and indexes your codebase into a local SQLite database (`.septum/septum.db`), validates module dependencies, and prevents unauthorized cross-boundary modifications.

---

## Installation

### Option 1: Standalone Binary (Recommended)

No need to install Bun, Node.js, or package managers. Download and install the prebuilt binary:

**Linux & macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/Shironim/septum/master/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Shironim/septum/master/install.ps1 | iex
```

> **Manual Downloads:** Precompiled binaries are also available on [GitHub Releases](https://github.com/Shironim/septum/releases) for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64.exe`.

### Option 2: Via Bun

If you already use [Bun](https://bun.sh):

```bash
bun add -g septum
```

> **Zero-Install:** You can also run commands directly using `bunx septum <command>`.

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
1. **Detects Project Structure:** Identifies module boundaries across Monorepos, Laravel, Next.js, NestJS, Express, Fastify, Hono, Elysia, Django, Flask, FastAPI, and Go.
2. **Indexes Codebase AST:** Ingests symbols, interfaces, and dependencies into `.septum/septum.db`.
3. **Scaffolds Agent Configurations:** Sets up MCP servers, skills, and pre-write hooks for supported environments:
   - **Antigravity** (`.gemini/`)
   - **Claude Code** (`.claude/`, `.mcp.json`, `CLAUDE.md`)
   - **Codex** (`.codex/`)
   - **Opencode** (`opencode/`, `opencode.json`)
   - **.agents Standard** (`.agents/`, `AGENTS.md`)

### 2. Manual MCP Client Configuration (Optional)

If your MCP client is not configured via `septum init`, add Septum to your MCP configuration (`.mcp.json` or `claude_desktop_config.json`):

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
| `septum init [--force]` | Detect project topology, scaffold agent integrations, and build initial symbol catalog. `--force` regenerates Septum-managed configs while preserving existing database and user git hooks |
| `septum sync [--json]` | Synchronize AST and update symbol catalog into `.septum/septum.db` (full or incremental) |
| `septum check [--strict] [--staged] [--feature <name>] [--json]` | Verify boundary rules and detect cross-domain or circular dependency violations |
| `septum feature [status\|clear] [--force]` | View or release active feature editing scope |
| `septum hook pre-write` | Pre-tool guard hook to validate proposed changes before file edits |
| `septum topology [subcommand]` | Inspect environment topology and infrastructure services |
| `septum serve` | Start stdio Model Context Protocol (MCP) server |

---

## MCP Tools

All tools provide structured schemas via the Model Context Protocol:

- **Domain & Architecture Overview (`septum_domain`):**
  - `action: "catalog"`: High-level architecture map and module dependencies (`detail_level: "compact" | "full"`).
  - `action: "register"`: Register or update domain boundaries with allowed and forbidden dependencies.
  - `action: "topology"`: Inspect deployment environment and infrastructure services.
- **Symbol Inspection & Impact Analysis (`septum_symbol`):**
  - `action: "locate"`: Search and find symbols across the codebase.
  - `action: "inspect"`: Inspect symbol declarations, signatures, and source snippets.
  - `action: "impact"`: Analyze call graphs, dependents, and refactoring blast radius.
  - `action: "hotspots"`: Identify complex functions based on line count and nesting depth.
- **Execution Flow Tracer (`septum_slice`):**
  - Trace call chains across application layers (*Route ➔ Controller ➔ Service ➔ Repository ➔ Entity*) from HTTP endpoints, queue jobs, CLI commands, or event handlers.
- **Dependency & Boundary Validator (`septum_boundary`):**
  - Validate proposed file imports against defined architectural rules (`scope: "file"`).
  - Check staged files (`scope: "staged"`), specific domains (`scope: "domain"`), or the whole codebase (`scope: "all"`) for circular dependencies and boundary violations.
- **Feature Scope Management (`septum_feature`):**
  - Restrict agent editing scope to designated touchpoint files during feature work to prevent unintended changes.

---

## License

[MIT](LICENSE) © shironim

