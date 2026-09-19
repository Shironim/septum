# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-19

### Added

- **Deterministic Bounded-Context & Anti-Poisoning Partition Engine**:
  - Implemented architecture partitioning across Laravel, NestJS, Go, Python, and TypeScript modules.
  - Enforces explicit `allowed_dependencies` and `forbidden_dependencies` to prevent cross-domain code leakage and accidental deletions.
- **Zero-Config Discovery & SQLite SSOT (`.septum/septum.db`)**:
  - `TopologyDetector`: Automatic project topology analysis and registration of domain boundaries directly into SQLite with WAL mode.
  - `IngestionPipeline`: Two-tier incremental hashing (inode mtime + SHA256 content hash) preventing redundant AST re-parsing.
- **Lifecycle Management (`septum init` & `septum sync`)**:
  - `septum init`: Bootstraps zero-config domain registration, `.gitignore` exclusions, git pre-commit hook, and AI Agent harness:
    - `.agents/rules/septum-boundary.md`: Strict agent boundary enforcement rules.
    - `.agents/skills/septum-map/SKILL.md`: Macro semantic map navigation skill.
    - `.agents/hooks/septum-pre-write.sh`: 3-Gate boundary guard hook intercepting disk mutations.
    - `.agents/hooks/septum-post-write.sh`: Automated post-write delta-sync trigger.
  - `septum sync`: Fast, incremental delta synchronization command updating changed files in milliseconds.
- **In-Process Background Watcher (`septum serve`)**:
  - Activated recursive filesystem watcher in `runMCPServer()` with 300ms debouncing, automatically re-ingesting modified domain files without interrupting MCP stdio JSON-RPC transport.
- **Deterministic Vertical Slice Tracing (`trace_vertical_slice`)**:
  - End-to-end fullstack trace from route entrypoint to controller, service, repository, and database.
  - Added explicit `confidence: "exact" | "inferred"` and `is_exact_match: boolean` metadata to eliminate hallucinated execution chains.
- **Dual-Sink Telemetry & Flight Recorder (`src/core/telemetry/telemetry.ts`)**:
  - Implemented `SeptumTelemetry` logging structured JSON Lines to `.septum/septum.log` with automatic 2MB file rotation (`septum.log.1`).
  - Measures execution latency (`duration_ms`), output density (`bytes_out`, `lines_out`), and correlates events with active feature sessions (`feature_key`, `domain`).
- **Standardized CLI Commands**:
  - Consolidated canonical feature session lock management to `septum feature [status|clear]`.
  - Full suite of 10 first-class MCP tools for AI Coding Agents.
- **Multi-Tier Hook Fallback**:
  - Enhanced Git pre-commit hooks and agent lifecycle hooks (`septum-pre-write.sh`, `septum-post-write.sh`) with resilient fallback chaining: local dev source (`bin/septum.ts`) ➔ global binary (`septum`) ➔ local project install (`./node_modules/.bin/septum`) ➔ on-demand execution (`bunx septum`).

