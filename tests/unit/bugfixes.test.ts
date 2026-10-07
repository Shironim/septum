import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { CallGraphTracer } from "../../src/core/resolver/call-graph-tracer.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { handleGetDomainCatalog } from "../../src/mcp/tools/get-domain-catalog.ts";
import { handleGetSymbolImpact } from "../../src/mcp/tools/get-symbol-impact.ts";
import { GoExtractor } from "../../src/core/parser/extractors/go.ts";
import { GetEnvironmentTopologySchema } from "../../src/mcp/schemas.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/check-boundary.ts";
import { handleGetFeatureContext } from "../../src/mcp/tools/get-feature-context.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";

describe("Septum Bugfixes Regression Suite (SP-1 to SP-7)", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let tempDir: string;

  const mockConfig: ValidatedSeptumConfig = {
    version: "1.0",
    settings: {
      enforcement: "strict",
      db_path: ":memory:",
      ignore_patterns: [],
    },
    domains: {
      billing: {
        root: "src/domains/billing",
        description: "Billing domain",
        allowed_dependencies: ["identity"],
        forbidden_dependencies: ["orders"],
        archetypes: {},
      },
      orders: {
        root: "src/domains/orders",
        description: "Orders domain",
        allowed_dependencies: ["billing"],
        forbidden_dependencies: ["identity"],
        archetypes: {},
      },
      identity: {
        root: "src/domains/identity",
        description: "Identity domain",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {},
      },
    },
    features: {},
  };

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("SP-2: Controller@Action FQCN and File Path Syntax", () => {
    it("should resolve vertical slice via FQCN namespace and file path formats", () => {
      // Upsert mock vertical slice
      repo.upsertVerticalSlice({
        route_uri: "/api/orders/{id}/status",
        http_method: "PUT",
        controller_class: "App\\Http\\Controllers\\OrderController",
        action_name: "updateStatus",
        domain_name: "orders",
        line_number: 42,
        route_name: "orders.update_status",
        entry_file: "app/Http/Controllers/OrderController.php",
        execution_chain_json: "[]",
      });

      const tracer = new VerticalSliceTracer(repo, tempDir);

      // 1. FQCN with backslashes
      const resFqcn = tracer.trace("App\\Http\\Controllers\\OrderController@updateStatus");
      expect(resFqcn.found).toBe(true);
      expect(resFqcn.entrypoint?.controller).toBe("App\\Http\\Controllers\\OrderController");

      // 2. Controller file path format with slash and .php extension
      const resPath = tracer.trace("app/Http/Controllers/OrderController.php@updateStatus");
      expect(resPath.found).toBe(true);
      expect(resPath.entrypoint?.action).toBe("updateStatus");

      // 3. Controller double-colon syntax (::)
      const resColon = tracer.trace("OrderController::updateStatus");
      expect(resColon.found).toBe(true);
      expect(resColon.entrypoint?.action).toBe("updateStatus");
    });
  });

  describe("SP-3: Boundary Evaluator Unmapped Domain Rejection", () => {
    it("should produce unmapped_domain violation for files outside any declared domain", () => {
      const evaluator = new BoundaryEvaluator(repo);
      const violations = evaluator.checkProposedChanges(
        "src/external/unmapped/RandomHelper.ts",
        ["src/domains/billing/PaymentService"],
        mockConfig
      );

      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe("unmapped_domain");
      expect(violations[0].source_domain).toBe("unmapped");
      expect(violations[0].message).toContain("does not belong to any declared bounded context");
    });
  });

  describe("SP-4: TS Path Aliases Multi-Target Existence Check", () => {
    it("should resolve to the target pattern whose file physically exists on disk", () => {
      // Create tsconfig.json with multiple targets for @/*
      const tsconfigContent = JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/candidate1/*", "src/candidate2/*"],
          },
        },
      });
      fs.writeFileSync(path.join(tempDir, "tsconfig.json"), tsconfigContent);

      // Candidate 1 does NOT exist, candidate 2 DOES exist in billing domain
      const cand2Dir = path.join(tempDir, "src", "candidate2", "billing");
      fs.mkdirSync(cand2Dir, { recursive: true });
      fs.writeFileSync(path.join(cand2Dir, "service.ts"), "export const service = {};");

      const resolver = new ModuleResolver(tempDir, repo);
      const targetDomain = resolver.resolveTargetDomain(
        "@/billing/service",
        undefined,
        {
          ...mockConfig,
          domains: {
            ...mockConfig.domains,
            billing: {
              root: path.join(tempDir, "src/candidate2/billing"),
              description: "Billing domain",
              allowed_dependencies: [],
              forbidden_dependencies: [],
              archetypes: {},
            },
          },
        }
      );

      expect(targetDomain).toBe("billing");
    });
  });

  describe("SP-5: Contextual Target Root for Catalog Access Audit Log", () => {
    it("should record catalog access in the specified workspace root instead of process.cwd()", () => {
      repo.upsertDomain("billing", {
        root: "src/domains/billing",
        description: "Billing domain",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {},
      });

      handleGetDomainCatalog(repo, mockConfig, { domain: "billing" }, tempDir);

      const auditFile = path.join(tempDir, ".septum", "catalog_access.json");
      expect(fs.existsSync(auditFile)).toBe(true);
      const auditContent = JSON.parse(fs.readFileSync(auditFile, "utf-8"));
      expect(auditContent.domains?.billing).toBeDefined();
    });
  });

  describe("SP-6: found_in_index Status and Diagnostic Warning in getSymbolImpact", () => {
    it("should return found_in_index: false and diagnostic warning for unindexed/fictional symbols", () => {
      const toolRes = handleGetSymbolImpact(repo, mockConfig, {
        symbol: "FictionalNonExistentService::ghostMethod",
      });

      const body = JSON.parse(toolRes.content[0].text);
      expect(body.target_symbol).toBe("FictionalNonExistentService::ghostMethod");
      expect(body.found_in_index).toBe(false);
      expect(body.warning).toBeDefined();
      expect(body.warning).toContain("was not found in Septum index");
      expect(body.impact_summary.total_dependents).toBe(0);
      expect(body.impact_summary.risk_level).toBe("low");
    });

    it("should return found_in_index: true when symbol exists in database", () => {
      // Seed a file and a symbol
      const domainId = repo.upsertDomain("billing", {
        root: "src/domains/billing",
        description: "Billing",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {},
      });

      const fileId = repo.upsertFile(
        domainId,
        "src/domains/billing/PaymentService.ts",
        "service",
        "hash123",
        100,
        Date.now(),
        1000
      );

      repo.replaceFileSymbols(fileId, [
        {
          name: "processPayment",
          kind: "method",
          signature: "public processPayment(): void",
          visibility: "public",
          line_start: 10,
          line_end: 20,
          line_count: 11,
        },
      ]);

      const toolRes = handleGetSymbolImpact(repo, mockConfig, {
        symbol: "processPayment",
      });

      const body = JSON.parse(toolRes.content[0].text);
      expect(body.target_symbol).toBe("processPayment");
      expect(body.found_in_index).toBe(true);
      expect(body.warning).toBeUndefined();
    });
  });

  describe("SP-8: ModuleResolver Third-Party Package Segment Matching Guard", () => {
    it("should NOT match third-party bare packages to domains with matching segment names", () => {
      const resolver = new ModuleResolver(tempDir, repo);
      // Even if domain named 'core' or 'identity' exists
      const configWithCore: ValidatedSeptumConfig = {
        ...mockConfig,
        domains: {
          ...mockConfig.domains,
          core: {
            root: "src/core",
            description: "Core domain",
            allowed_dependencies: [],
            forbidden_dependencies: [],
            archetypes: {},
          },
        },
      };

      // @nestjs/core or crypto-js/core should NOT resolve to domain 'core'
      const targetNest = resolver.resolveTargetDomain("@nestjs/core", undefined, configWithCore);
      expect(targetNest).toBeNull();

      const targetCrypto = resolver.resolveTargetDomain("crypto-js/sha256", undefined, configWithCore);
      expect(targetCrypto).toBeNull();
    });
  });

  describe("SP-9: ModuleResolver PSR-4 Longest-Prefix-First Ordering", () => {
    it("should match most specific PSR-4 namespace prefix when shorter prefix appears first", () => {
      const composerContent = JSON.stringify({
        autoload: {
          "psr-4": {
            "App\\": "app/",
            "App\\Domain\\Billing\\": "src/domains/billing/",
          },
        },
      });
      fs.writeFileSync(path.join(tempDir, "composer.json"), composerContent);

      const resolver = new ModuleResolver(tempDir, repo);
      const targetDomain = resolver.resolveTargetDomain(
        "App\\Domain\\Billing\\InvoiceService",
        undefined,
        mockConfig
      );
      expect(targetDomain).toBe("billing");
    });
  });

  describe("SP-10: VerticalSliceTracer Express/Nest Colon Parameter Symmetry in urisMatch", () => {
    it("should match Express colon-parameterized route with query route", () => {
      repo.upsertVerticalSlice({
        route_uri: "/api/orders/:orderId/items",
        http_method: "GET",
        controller_class: "OrderController",
        action_name: "listItems",
        domain_name: "orders",
        line_number: 10,
        route_name: "orders.items",
        entry_file: "src/controllers/OrderController.ts",
        execution_chain_json: "[]",
      });

      const tracer = new VerticalSliceTracer(repo, tempDir);
      // Query with different parameter name /:id
      const res = tracer.trace("/api/orders/:id/items");
      expect(res.found).toBe(true);
      expect(res.entrypoint?.action).toBe("listItems");
    });
  });

  describe("SP-11: VerticalSliceTracer Bare-Word Controller Hijacking Guard", () => {
    it("should NOT hijack generic word as controller when no controller class matches exactly", () => {
      repo.upsertVerticalSlice({
        route_uri: "/api/checkout",
        http_method: "POST",
        controller_class: "OrderCheckoutProcessController",
        action_name: "process",
        domain_name: "orders",
        line_number: 15,
        route_name: "checkout.process",
        entry_file: "src/controllers/OrderCheckoutProcessController.php",
        execution_chain_json: "[]",
      });

      const tracer = new VerticalSliceTracer(repo, tempDir);
      // Query "process" without @ or controller suffix should not exact-match controller
      const res = tracer.trace("process");
      // It should match via symbol/action match or token scoring, not hijacking controller step
      expect(res.found).toBe(true);
    });
  });

  describe("SP-12: BoundaryEvaluator Cross-Domain Feature Touchpoint Isolation", () => {
    it("should reject touchpoint with same filename in different domain", () => {
      const evaluator = new BoundaryEvaluator(repo);
      const configWithFeature: ValidatedSeptumConfig = {
        ...mockConfig,
        features: {
          "user-auth": {
            domain: "identity",
            description: "User authentication",
            allowed_touchpoints: ["types.ts"],
          },
        },
      };

      // File in billing domain with same name types.ts should NOT be allowed for identity feature
      const violations = evaluator.checkFeatureTouchpoints(
        "user-auth",
        "src/domains/billing/types.ts",
        configWithFeature
      );

      expect(violations.length).toBe(1);
      expect(violations[0].rule).toBe("touchpoint_violation");
    });
  });

  describe("SP-13: GoExtractor Third-Party Module External Classification", () => {
    it("should classify third-party Go modules as external and stdlib as external", async () => {
      const extractor = new GoExtractor();
      const goCode = `package billing
import (
    "fmt"
    "github.com/gin-gonic/gin"
    "github.com/org/repo/src/domains/orders"
)
`;
      const ast = await extractor.extract("src/domains/billing/service.go", goCode);

      const fmtDep = ast.dependencies.find((d) => d.target === "fmt");
      expect(fmtDep?.is_external).toBe(true);

      const ginDep = ast.dependencies.find((d) => d.target === "github.com/gin-gonic/gin");
      expect(ginDep?.is_external).toBe(true);

      const internalDep = ast.dependencies.find((d) => d.target.includes("orders"));
      expect(internalDep?.is_external).toBe(false);
    });
  });

  describe("SP-14: GetEnvironmentTopologySchema Snake_Case Aliases Preprocessing", () => {
    it("should accept resolve_node and snake_case nested keys without throwing validation error", () => {
      const input = {
        resolve_node: {
          id: "runtime-node-1",
          layer: "runtime",
          name: "Bun Runtime",
          platform: "bun",
          canonical_tag: "vps",
          domain_or_ip: "127.0.0.1",
          role: "api-server",
        },
      };

      const parsed = GetEnvironmentTopologySchema.safeParse(input);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.resolveNode).toBeDefined();
        expect(parsed.data.resolveNode?.id).toBe("runtime-node-1");
        expect(parsed.data.resolveNode?.name).toBe("Bun Runtime");
      }
    });
  });

  describe("SP-15: CheckBoundary Batch Evaluation Unindexed Warning", () => {
    it("should include unindexed notice in batch mode when domain catalog has 0 domains", () => {
      const evaluator = new BoundaryEvaluator(repo);
      const emptyConfig: ValidatedSeptumConfig = {
        ...mockConfig,
        domains: {},
      };

      const res = handleCheckBoundary(
        evaluator,
        emptyConfig,
        { file_paths: ["src/file1.ts", "src/file2.ts"] },
        repo
      );

      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.status).toBe("approved");
      expect(parsed.message).toContain("Domain catalog is currently unindexed");
    });
  });

  describe("SP-16: handleGetFeatureContext Workspace Root Session Lease", () => {
    it("should save active session inside specified workspaceRoot instead of process.cwd()", () => {
      const configWithFeature: ValidatedSeptumConfig = {
        ...mockConfig,
        features: {
          "order-checkout": {
            domain: "orders",
            description: "Checkout flow",
            allowed_touchpoints: ["src/domains/orders/checkout.ts"],
          },
        },
      };

      handleGetFeatureContext(repo, configWithFeature, { feature: "order-checkout" }, tempDir);

      const sessionFile = path.join(tempDir, ".septum", "session.json");
      expect(fs.existsSync(sessionFile)).toBe(true);
      const sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
      expect(sessionData.feature_key).toBe("order-checkout");
      expect(sessionData.domain).toBe("orders");
    });
  });

  describe("SP-17: Pipeline autoDiscoverDomains for Laravel routes and database", () => {
    it("should discover routes and database domains if directories exist in Laravel project", () => {
      // Create minimal Laravel structure in tempDir
      fs.writeFileSync(path.join(tempDir, "artisan"), "#!/usr/bin/env php\n");
      fs.mkdirSync(path.join(tempDir, "app"), { recursive: true });
      fs.mkdirSync(path.join(tempDir, "routes"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "routes", "web.php"), "<?php // route");
      fs.mkdirSync(path.join(tempDir, "database", "migrations"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "database", "migrations", "001_create_users.php"), "<?php");

      const pipeline = new IngestionPipeline(repo, tempDir);
      const discovered = (pipeline as any).autoDiscoverDomains(tempDir);

      expect(discovered.app).toBeDefined();
      expect(discovered.routes).toBeDefined();
      expect(discovered.routes.root).toBe("routes");
      expect(discovered.routes.archetypes?.route).toBe("routes/**/*.php");
      expect(discovered.database).toBeDefined();
      expect(discovered.database.root).toBe("database");
    });
  });

  describe("SP-18: DomainRepository Batch Symbol Query (Anti-N+1)", () => {
    it("should correctly assemble symbols for multiple files in getDomainCatalog via single batch query", () => {
      const domainId = repo.upsertDomain("billing", {
        root: "src/domains/billing",
        description: "Billing domain",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {},
      });

      const file1Id = repo.upsertFile(domainId, "src/domains/billing/f1.ts", "service", "hash1", 50);
      const file2Id = repo.upsertFile(domainId, "src/domains/billing/f2.ts", "service", "hash2", 60);

      repo.replaceFileSymbols(file1Id, [
        { name: "ServiceOne", kind: "class", signature: "class ServiceOne", visibility: "public", line_start: 1, line_end: 20, line_count: 20 },
      ]);
      repo.replaceFileSymbols(file2Id, [
        { name: "ServiceTwo", kind: "class", signature: "class ServiceTwo", visibility: "public", line_start: 1, line_end: 25, line_count: 25 },
      ]);

      const catalog = repo.domains.getDomainCatalog("billing");
      expect(catalog).toBeDefined();
      expect(catalog?.files.length).toBe(2);

      const f1 = catalog?.files.find((f) => f.path === "src/domains/billing/f1.ts");
      expect(f1?.symbols.some((s) => s.name === "ServiceOne")).toBe(true);

      const f2 = catalog?.files.find((f) => f.path === "src/domains/billing/f2.ts");
      expect(f2?.symbols.some((s) => s.name === "ServiceTwo")).toBe(true);
    });
  });

  describe("SP-19: FileRepository Batch Delete (Anti-N+1)", () => {
    it("should batch delete stale files efficiently", () => {
      const domainId = repo.upsertDomain("orders", {
        root: "src/domains/orders",
        description: "Orders",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {},
      });

      repo.upsertFile(domainId, "src/domains/orders/keep.ts", "service", "h1", 10);
      repo.upsertFile(domainId, "src/domains/orders/stale1.ts", "service", "h2", 10);
      repo.upsertFile(domainId, "src/domains/orders/stale2.ts", "service", "h3", 10);

      const deletedCount = repo.files.deleteFilesNotInPaths(domainId, ["src/domains/orders/keep.ts"]);
      expect(deletedCount).toBe(2);

      const remaining = repo.files.getFilesByDomain(domainId);
      expect(remaining.length).toBe(1);
      expect(remaining[0].path).toBe("src/domains/orders/keep.ts");
    });
  });

  describe("SP-20: CallGraphTracer getAllFiles and O(1) locateSymbol", () => {
    it("should populate fileMapById and locate symbol without O(N*M) linear scan", () => {
      const domainId = repo.upsertDomain("billing", {
        root: "src/domains/billing",
        description: "Billing",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {},
      });

      const fileId = repo.upsertFile(domainId, "src/domains/billing/service.ts", "service", "h1", 10);
      repo.replaceFileSymbols(fileId, [
        { name: "calculateTotal", kind: "function", signature: "function calculateTotal()", visibility: "public", line_start: 12, line_end: 24, line_count: 13 },
      ]);

      const tracer = new CallGraphTracer(repo, tempDir);
      tracer.initMaps();

      const located = (tracer as any).locateSymbol("calculateTotal");
      expect(located).not.toBeNull();
      expect(located?.file).toBe("src/domains/billing/service.ts");
      expect(located?.line).toBe(12);
    });
  });
});
