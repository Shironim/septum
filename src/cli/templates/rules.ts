export const SEPTUM_RULES_TEMPLATE = `# Software Architecture, Modular Boundaries & Symbol Reuse Guidelines

> **Core Principle:** This codebase enforces modular architecture and the DRY (Don't Repeat Yourself) principle. An embedded database (\`.septum/septum.db\`) maintains the Single Source of Truth (SSOT) for the project symbol table, call graph, and dependency graph. Code modifications must respect module boundaries and reuse existing abstractions.

---

## 1. Symbol Reuse & Module Discovery (Before Writing New Code)

Before declaring a new class, interface, function, method, or shared type:
1. **Inspect Module Catalog & File Dependencies:**
   Call \`septum_domain({ action: "catalog", domain: "<domain_name>", detail_level: "compact" })\` (or omit \`domain\` for the top-level architecture overview).
   * Review existing declarations (\`class\`, \`interface\`, \`struct\`, \`function\`, \`type\`, \`constant\`, \`variable\`) and their line span.
   * Review imported modules (\`connections.imports_from\`) and consumer count (\`connections.imported_by_count\`).
   * For complete method signatures of a specific component, call \`septum_symbol({ action: "inspect", query: "<SymbolName>" })\`.
2. **Search for Existing Utilities and Abstractions:**
   Call \`septum_symbol({ action: "locate", query: "<keyword>" })\` to verify whether a utility, service, or helper already exists before implementing duplicate logic.
3. **Scope Constraints for Features:**
   When working within an assigned feature branch or task, call \`septum_feature({ action: "get", feature_key: "<feature_name>" })\`:
   * **Respect \`allowed_touchpoints\`:** Restrict modifications strictly to files within the designated module scope.
   * **Reuse \`reuse_symbols\`:** Import and extend registered components from \`reuse_symbols\` instead of re-implementing them.

---

## 2. Impact Analysis & Breaking Change Prevention (Before Refactoring)

1. **Analyze Call Graph Dependencies (\`inbound_callers\`):**
   Before altering method signatures, changing parameter contracts, or deprecating public symbols, check all dependents:
   \`\`\`json
   septum_symbol({ "action": "impact", "query": "ClassNameOrFunction" })
   \`\`\`
   Review all \`inbound_callers\` (direct callers and cross-module named imports) to prevent breaking upstream consumers.
2. **Trace End-to-End Execution Flow (Vertical Slices):**
   Call \`septum_slice({ query: "<route|command|handler>", max_depth: 5 })\` (scale up to \`max_depth: 8\` for asynchronous events, message queues, or layered middleware) to trace call chains from API ingress down to data persistence.

---

## 3. Dependency Validation & Static Boundary Checks

1. **Pre-Validate Proposed Module Imports:**
   Before adding new cross-module dependencies, validate whether the dependency direction conforms to the architecture:
   \`\`\`json
   septum_boundary({
     "file_path": "src/modules/order/service.ts",
     "proposed_imports": ["../billing/service"],
     "feature_key": "optional_feature_key"
   })
   \`\`\`
2. **Verify Against Circular Dependencies and Boundary Leaks:**
   Run \`septum_boundary({ scope: "staged" })\` or \`septum_boundary({ scope: "all" })\` prior to committing changes. If the check returns \`rejected\` (due to \`forbidden_dependency\`, \`disallowed_dependency\`, \`touchpoint_violation\`, or \`circular_dependency\`), refactor the import hierarchy to preserve clean dependency inversion.
`;
