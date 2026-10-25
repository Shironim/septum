export const SEPTUM_MAP_SKILL_TEMPLATE = `---
name: septum-map
description: Framework-agnostic codebase architecture and dependency graph analysis. Use when initializing project boundaries, inspecting the symbol table, validating cross-module imports, or reviewing static analysis check results.
---

# \`septum-map\` — Codebase Architecture & Static Analysis

> **Core Principle:** Static analysis indexes AST declarations and dependency graphs to provide deterministic structural evidence. Treat index data as static structural facts, not full runtime trace validation.

## Scope

Use this skill to navigate the project architecture, verify module boundaries, locate reusable symbols, trace execution flows, and validate dependency rules. This skill guides architectural compliance; domain business decisions remain governed by project specifications.

## Tool & Command Reference

The active MCP schema and \`septum --help\` represent the authoritative interface contracts:

| Tool | Capability | Considerations |
|---|---|---|
| \`septum_domain\` | \`catalog\` inspects module architecture (supports \`detail_level: "compact"\`); \`register\` defines domain roots; \`topology\` logs infrastructure layers. | Domain registration mutates database state. Directory structures serve as modular hints. |
| \`septum_symbol\` | \`locate\`, \`inspect\`, \`impact\`, or \`hotspots\` across the project symbol table. | Backed by Tree-Sitter AST parsers. Impact analysis reports static inbound callers across the dependency graph. |
| \`septum_slice\` | Traces end-to-end execution paths from ingress handlers down through services and repositories; \`max_depth\` bounds call graph traversal. | Returns matched call graph chains; confidence metrics reflect static AST resolution depth. |
| \`septum_boundary\` | Validates proposed imports and detects \`circular_dependency\` cycles across scopes (\`file\`, \`staged\`, \`domain\`, \`all\`). | Evaluates allowed/forbidden dependency rules. Status \`approved\` confirms zero policy violations in the checked scope. |
| \`septum_feature\` | \`get\` retrieves active task context; \`lock\` registers task touchpoints; \`release\` clears locks. | Restricts edits to authorized module touchpoints during concurrent development sessions. |

Common CLI commands: \`septum init\` initializes project configuration and agent hooks; \`septum sync\` updates the AST index; \`septum check\` runs static boundary checks on staged or workspace files.

## Architectural Review Workflow

1. **Verify Project Context:** Ensure working directory is aligned. Check that \`.septum/septum.db\` is present. Pass \`workspace_path\` when operating in multi-root workspaces.
2. **Inspect Module Inventory:** Query the domain catalog to determine registered modules, AST index status, and file coverage metrics. If files are marked unsupported or skipped, note partial coverage.
3. **Differentiate Evidence from Assumptions:** Use concrete AST symbols, public exports, and declared configuration as evidence. Never guess interfaces or assume unverified dependencies.
4. **Identify Reusable Components:** Search existing services, models, and utility classes before introducing new declarations to adhere to the DRY principle.
5. **Analyze Refactoring Blast Radius:** Check inbound callers (\`septum_symbol impact\`) before modifying public method signatures or removing exported declarations.
6. **Validate Dependency Boundaries:** Run pre-commit checks (\`septum_boundary\`) to ensure proposed imports avoid circular dependencies and respect architectural layering.

## Interpreting Analysis Results

- \`approved\`: No architectural violations or circular dependencies detected within the evaluated scope.
- \`rejected\`: A boundary violation (\`forbidden_dependency\`, \`disallowed_dependency\`, or \`circular_dependency\`) occurred. The import hierarchy must be refactored.
- \`unknown\` or partial index status: Indexing is incomplete; review unsupported files before concluding compliance.
- Absence of a symbol: Indicates no match in the current AST index, signaling an opportunity to implement or check naming spelling.

## Standardized Reporting Format

When summarizing architectural checks:
- **Scope & Action:** Audited file path or module, tool invoked, and whether database state was modified.
- **Structural Evidence:** Exact symbol declarations, caller counts, or dependency paths identified.
- **Status & Violations:** Clear pass/fail outcome with specific rule violations or circular dependency paths if detected.
- **Recommended Action:** Remediation steps (e.g. dependency inversion, extracting shared interfaces, or reusing existing utilities).
`;
