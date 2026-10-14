import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { SessionManager } from "../../src/core/session/session-manager.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/check-boundary.ts";
import { handleRegisterFeature } from "../../src/mcp/tools/register-feature.ts";
import { handleGetFeatureContext } from "../../src/mcp/tools/get-feature-context.ts";
import { handleRegisterDomain } from "../../src/mcp/tools/register-domain.ts";
import { handleGetSymbol } from "../../src/mcp/tools/get-symbol.ts";
import { handleGetSymbolImpact } from "../../src/mcp/tools/get-symbol-impact.ts";
import { handleGetEnvironmentTopology } from "../../src/mcp/tools/get-environment-topology.ts";
import { EnvironmentDetector } from "../../src/core/topology/environment-detector.ts";
import { McpCliSemanticExtractor } from "../../src/core/parser/extractors/mcp-cli-semantic.ts";
import { CallGraphTracer } from "../../src/core/resolver/call-graph-tracer.ts";
import { auditStagedFiles } from "../../src/core/boundary/staged-auditor.ts";

describe("MCP Audit Fixes Regression Suite (MCP-01 to MCP-16)", () => {
  let tempDir: string;
  let db: SeptumDatabase;
  let repo: SeptumRepository;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-audit-suite-"));
    fs.mkdirSync(path.join(tempDir, ".septum"), { recursive: true });
    db = new SeptumDatabase(path.join(tempDir, ".septum", "septum.db"));
    repo = new SeptumRepository(db.raw);
    repo.setMeta("sync_state", "complete");
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // MCP-01: Corrupt session recovery
  describe("MCP-01: Session recovery on malformed session JSON", () => {
    it("allows force release when session.json is malformed JSON", () => {
      const sessionPath = path.join(tempDir, ".septum", "session.json");
      fs.writeFileSync(sessionPath, "{broken-json");

      expect(() => SessionManager.getActiveSession(tempDir)).toThrow(/Corrupted active feature session/);
      expect(() => SessionManager.clearActiveSession(tempDir, undefined, false)).toThrow();

      // Force clear should succeed and delete the corrupt file
      const cleared = SessionManager.clearActiveSession(tempDir, undefined, true);
      expect(cleared).toBe(true);
      expect(fs.existsSync(sessionPath)).toBe(false);
    });
  });

  // MCP-03: Active feature lock enforced when feature_key is omitted
  describe("MCP-03: Active feature lock enforcement", () => {
    it("enforces touchpoints of active lock even when feature_key is omitted", async () => {
      repo.upsertDomain("orders", { root: "src/orders" });
      repo.upsertDomain("billing", { root: "src/billing" });

      const config: ValidatedSeptumConfig = {
        ...ConfigLoader.getDefaultConfig(),
        domains: {
          orders: { root: "src/orders", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
          billing: { root: "src/billing", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
        },
      };

      await handleRegisterFeature(
        repo,
        config,
        {
          feature_key: "f1",
          domain: "orders",
          allowed_touchpoints: ["src/orders/Order.php"],
        },
        tempDir
      );

      const resolver = new ModuleResolver(tempDir, repo);
      const evaluator = new BoundaryEvaluator(repo, resolver);

      // Checking Payment.php without feature_key should be rejected because f1 is active
      const res = await handleCheckBoundary(
        evaluator,
        config,
        { file_path: "src/billing/Payment.php" },
        repo,
        tempDir
      );

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.status).toBe("rejected");
      expect(parsed.violations.some((v: any) => v.rule === "touchpoint_violation")).toBe(true);
    });

    it("rejects different feature_key when another feature is actively locked", async () => {
      repo.upsertDomain("orders", { root: "src/orders" });
      const config: ValidatedSeptumConfig = {
        ...ConfigLoader.getDefaultConfig(),
        domains: {
          orders: { root: "src/orders", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
        },
      };

      await handleRegisterFeature(
        repo,
        config,
        {
          feature_key: "f1",
          domain: "orders",
          allowed_touchpoints: ["src/orders/Order.php"],
        },
        tempDir
      );

      const resolver = new ModuleResolver(tempDir, repo);
      const evaluator = new BoundaryEvaluator(repo, resolver);

      expect(
        handleCheckBoundary(
          evaluator,
          config,
          { file_path: "src/orders/Order.php", feature_key: "different_key" },
          repo,
          tempDir
        )
      ).rejects.toThrow(/Active feature lock is 'f1'/);
    });

    it("rejects feature_key parameter on scope all or domain", async () => {
      repo.upsertDomain("orders", { root: "src/orders" });
      const config: ValidatedSeptumConfig = {
        ...ConfigLoader.getDefaultConfig(),
        domains: {
          orders: { root: "src/orders", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
        },
      };

      const resolver = new ModuleResolver(tempDir, repo);
      const evaluator = new BoundaryEvaluator(repo, resolver);

      const res = await handleCheckBoundary(
        evaluator,
        config,
        { scope: "all", feature_key: "f1" },
        repo,
        tempDir
      );

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.status).toBe("rejected");
      expect(parsed.message).toContain("Scope 'all' is an architectural audit");
    });
  });

  // MCP-04: Workspace root propagation in symbol inspect & impact
  describe("MCP-04: Workspace root containment in symbol inspection", () => {
    it("reads source file from workspaceRoot instead of process.cwd()", () => {
      const domainId = repo.upsertDomain("orders", { root: "src/orders" });
      const fileId = repo.upsertFile(domainId, "src/orders/Order.php", "controller", "h1", 10);
      repo.replaceFileSymbols(fileId, [
        {
          name: "OrderController::submit",
          kind: "method",
          signature: "public function submit()",
          visibility: "public",
          line_start: 2,
          line_end: 4,
          line_count: 3,
        },
      ]);

      // Write physical file in tempDir
      fs.mkdirSync(path.join(tempDir, "src", "orders"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "src", "orders", "Order.php"),
        "<?php\nclass OrderController {\n  public function submit() {\n    PaymentService::refund();\n  }\n}\n"
      );

      const config = ConfigLoader.getDefaultConfig();
      const res = handleGetSymbol(
        repo,
        config,
        { symbol: "OrderController::submit" },
        tempDir
      );

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.outbound_calls).toContain("PaymentService::refund");
    });
  });

  // MCP-05 & MCP-15: SQLite SSOT persistence and domain validation
  describe("MCP-05 & MCP-15: Feature lock persistence and validation", () => {
    it("rejects unknown domain when locking feature", async () => {
      const config = ConfigLoader.getDefaultConfig();
      expect(
        handleRegisterFeature(
          repo,
          config,
          { feature_key: "f1", domain: "NON_EXISTENT_DOMAIN" },
          tempDir
        )
      ).rejects.toThrow(/Domain 'NON_EXISTENT_DOMAIN' is not registered/);
    });

    it("rejects unsupported touchpoint glob patterns", async () => {
      repo.upsertDomain("orders", { root: "src/orders" });
      const config = ConfigLoader.getDefaultConfig();
      expect(
        handleRegisterFeature(
          repo,
          config,
          { feature_key: "f1", domain: "orders", allowed_touchpoints: ["src/orders/*.php"] },
          tempDir
        )
      ).rejects.toThrow(/Unsupported touchpoint glob pattern/);
    });

    it("does not leave phantom session if SQLite write fails", async () => {
      repo.upsertDomain("orders", { root: "src/orders" });
      const config = ConfigLoader.getDefaultConfig();

      // Install trigger that aborts SQLite write
      db.raw.run(
        "CREATE TRIGGER reject_features BEFORE INSERT ON repo_meta WHEN NEW.key='features_json' BEGIN SELECT RAISE(ABORT,'simulated persistence failure'); END;"
      );

      expect(
        handleRegisterFeature(
          repo,
          config,
          { feature_key: "lost", domain: "orders", allowed_touchpoints: ["src/orders/a.ts"] },
          tempDir
        )
      ).rejects.toThrow(/simulated persistence failure/);

      // Verify no session file was left behind
      expect(fs.existsSync(path.join(tempDir, ".septum", "session.json"))).toBe(false);
      // Verify in-memory config is clean
      expect(config.features?.lost).toBeUndefined();
    });
  });

  // MCP-06: Topology refresh preserves VERIFIED layers
  describe("MCP-06: Topology refresh preserves VERIFIED status", () => {
    it("preserves manual VERIFIED platform and constraints during refresh: true", () => {
      const config = ConfigLoader.getDefaultConfig();

      // Resolve host manually
      handleGetEnvironmentTopology(
        repo,
        config,
        {
          resolve: {
            layer: "host",
            platform: "AUDIT-MANUAL-VPS",
            constraints: ["KEEP_ME"],
          },
        },
        tempDir
      );

      // Trigger force refresh
      handleGetEnvironmentTopology(
        repo,
        config,
        { refresh: true },
        tempDir
      );

      // Read back topology
      const hostLayer = repo.environment.getLayer("host");
      expect(hostLayer?.status).toBe("VERIFIED");
      expect(hostLayer?.platform).toBe("AUDIT-MANUAL-VPS");
      expect(hostLayer?.constraints).toContain("KEEP_ME");
    });
  });

  // MCP-07: McpCliSemanticExtractor whitelist
  describe("MCP-07: MCP semantic extractor only emits registered tools", () => {
    it("does not create phantom ingress slices for internal helpers", () => {
      const extractor = new McpCliSemanticExtractor();
      const slices = extractor.extractSlices(process.cwd());
      const mcpRouteNames = slices.filter((s) => s.http_method === "MCP").map((s) => s.route_name);

      expect(mcpRouteNames).not.toContain("septum_get_symbol");
      expect(mcpRouteNames).not.toContain("septum_register_domain");
      expect(mcpRouteNames).not.toContain("septum_check_boundary");
      expect(mcpRouteNames).toContain("septum_domain");
      expect(mcpRouteNames).toContain("septum_symbol");
      expect(mcpRouteNames).toContain("septum_slice");
      expect(mcpRouteNames).toContain("septum_boundary");
      expect(mcpRouteNames).toContain("septum_feature");
      expect(mcpRouteNames).toHaveLength(5);
    });
  });

  // MCP-08: CallGraphTracer does not fabricate ::execute
  describe("MCP-08: CallGraphTracer symbol display", () => {
    it("does not append ::execute to class symbols without execute method", () => {
      const domainId = repo.upsertDomain("core", { root: "src/core" });
      const f1Id = repo.upsertFile(domainId, "src/core/ModuleA.ts", "service", "h1", 20);
      const f2Id = repo.upsertFile(domainId, "src/core/ModuleB.ts", "service", "h2", 20);

      repo.replaceFileSymbols(f1Id, [
        { name: "ModuleA", kind: "class", signature: "class ModuleA", visibility: "public", line_start: 1, line_end: 10, line_count: 10 },
      ]);
      repo.replaceFileSymbols(f2Id, [
        { name: "ModuleB", kind: "class", signature: "class ModuleB", visibility: "public", line_start: 1, line_end: 10, line_count: 10 },
      ]);
      repo.dependencies.replaceFileDependencies(f1Id, [
        { target: "./ModuleB.ts", statement: "import { ModuleB } from './ModuleB';", line_number: 1, is_external: false },
      ]);

      const tracer = new CallGraphTracer(repo, tempDir);
      const chain = tracer.expandChainFromFile("src/core/ModuleA.ts", [], 5);
      expect(chain.length).toBeGreaterThan(0);

      for (const node of chain) {
        expect(node.symbol.endsWith("::execute")).toBe(false);
      }
    });
  });

  // MCP-09 & MCP-10: Symbol impact method and domain validation
  describe("MCP-09 & MCP-10: Symbol impact validation", () => {
    it("returns found_in_index: false for non-existent method on existing class", () => {
      const domainId = repo.upsertDomain("orders", { root: "src/orders" });
      const fileId = repo.upsertFile(domainId, "src/orders/Order.php", "controller", "h1", 10);
      repo.replaceFileSymbols(fileId, [
        { name: "OrderController", kind: "class", signature: "class OrderController", visibility: "public", line_start: 1, line_end: 10, line_count: 10 },
        { name: "OrderController::submit", kind: "method", signature: "public function submit()", visibility: "public", line_start: 2, line_end: 5, line_count: 4 },
      ]);

      const impact = repo.getSymbolImpact("OrderController::doesNotExist");
      expect(impact.found_in_index).toBe(false);
      expect(impact.impact_summary.risk_level).toBe("unknown");
    });

    it("returns found_in_index: false when domain filter does not match", () => {
      const domainId = repo.upsertDomain("orders", { root: "src/orders" });
      const fileId = repo.upsertFile(domainId, "src/orders/Order.php", "controller", "h1", 10);
      repo.replaceFileSymbols(fileId, [
        { name: "OrderController", kind: "class", signature: "class OrderController", visibility: "public", line_start: 1, line_end: 10, line_count: 10 },
      ]);

      const impact = repo.getSymbolImpact("OrderController", { domain: "NON_EXISTENT" });
      expect(impact.found_in_index).toBe(false);
    });
  });

  // MCP-11: include_dependencies=false skips dependency analysis
  describe("MCP-11: include_dependencies parameter in symbol inspect", () => {
    it("omits outbound calls and injected dependencies when include_dependencies is false", () => {
      const domainId = repo.upsertDomain("orders", { root: "src/orders" });
      const fileId = repo.upsertFile(domainId, "src/orders/Order.php", "controller", "h1", 10);
      repo.replaceFileSymbols(fileId, [
        { name: "OrderController::submit", kind: "method", signature: "public function submit(PaymentService $p)", visibility: "public", line_start: 1, line_end: 5, line_count: 5 },
      ]);

      const details = repo.getSymbolDetails("OrderController::submit", { includeDependencies: false });
      expect(details).not.toBeNull();
      expect(details?.outbound_calls).toEqual([]);
      expect(details?.dependencies_injected).toEqual([]);
      expect(details?.resolved_outbound_calls).toBeUndefined();
    });
  });

  // MCP-12 & MCP-13: Domain updates and case identity
  describe("MCP-12 & MCP-13: Domain updates and case identity", () => {
    it("clears forbidden_dependencies when explicit empty array [] is passed", async () => {
      const config = ConfigLoader.getDefaultConfig();

      // Register with forbidden_dependencies: ["billing"]
      await handleRegisterDomain(
        repo,
        config,
        { domain: "orders", root: "src/orders", forbidden_dependencies: ["billing"] },
        tempDir
      );

      let stored = repo.domains.getDomainByName("orders");
      expect(JSON.parse(stored?.forbidden_deps_json || "[]")).toEqual(["billing"]);

      // Re-register with explicit empty array []
      await handleRegisterDomain(
        repo,
        config,
        { domain: "orders", root: "src/orders", forbidden_dependencies: [] },
        tempDir
      );

      stored = repo.domains.getDomainByName("orders");
      expect(JSON.parse(stored?.forbidden_deps_json || "[]")).toEqual([]);
    });

    it("preserves forbidden_dependencies when omitted (undefined)", async () => {
      const config = ConfigLoader.getDefaultConfig();

      await handleRegisterDomain(
        repo,
        config,
        { domain: "orders", root: "src/orders", forbidden_dependencies: ["billing"] },
        tempDir
      );

      // Re-register without forbidden_dependencies
      await handleRegisterDomain(
        repo,
        config,
        { domain: "orders", root: "src/orders" },
        tempDir
      );

      const stored = repo.domains.getDomainByName("orders");
      expect(JSON.parse(stored?.forbidden_deps_json || "[]")).toEqual(["billing"]);
    });

    it("canonicalizes domain case identity and does not create duplicate rows", () => {
      const id1 = repo.upsertDomain("orders", { root: "src/orders" });
      const id2 = repo.upsertDomain("Orders", { root: "src/other" });

      expect(id1).toBe(id2);
      const all = repo.getAllDomains();
      expect(all.filter((d) => d.name.toLowerCase() === "orders").length).toBe(1);
    });
  });

  // MCP-14: Feature get is read-only
  describe("MCP-14: handleGetFeatureContext is strictly read-only", () => {
    it("does not create or mutate session.json on get", () => {
      repo.upsertDomain("orders", { root: "src/orders" });
      const config: ValidatedSeptumConfig = {
        ...ConfigLoader.getDefaultConfig(),
        domains: {
          orders: { root: "src/orders", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
        },
        features: {
          f1: {
            domain: "orders",
            description: "Feature 1",
            allowed_touchpoints: ["src/orders/a.ts"],
          },
        },
      };

      const sessionFile = path.join(tempDir, ".septum", "session.json");
      expect(fs.existsSync(sessionFile)).toBe(false);

      handleGetFeatureContext(repo, config, { feature_key: "f1" }, tempDir);

      // Must remain non-existent
      expect(fs.existsSync(sessionFile)).toBe(false);
    });
  });
});
