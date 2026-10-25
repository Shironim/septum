import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeContentHash } from "../../src/core/ingestion/hasher.ts";
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { TypeScriptExtractor } from "../../src/core/parser/extractors/typescript.ts";
import { PHPExtractor } from "../../src/core/parser/extractors/php.ts";
import { PythonExtractor } from "../../src/core/parser/extractors/python.ts";
import { GoExtractor } from "../../src/core/parser/extractors/go.ts";
import { handleGetDomainCatalog } from "../../src/mcp/tools/get-domain-catalog.ts";
import { handleGetSymbol } from "../../src/mcp/tools/get-symbol.ts";
import { handleGetSymbolImpact } from "../../src/mcp/tools/get-symbol-impact.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/check-boundary.ts";
import { handleTraceVerticalSlice } from "../../src/mcp/tools/trace-vertical-slice.ts";
import { GetDomainCatalogSchema, TraceVerticalSliceSchema } from "../../src/mcp/schemas.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { SEPTUM_MAP_SKILL_TEMPLATE } from "../../src/cli/templates/skill.ts";
import { SEPTUM_RULES_TEMPLATE } from "../../src/cli/templates/rules.ts";
import { SEPTUM_HOOKS_CONFIG } from "../../src/cli/templates/hooks.ts";

describe("Refactored Capabilities & Regression Verification", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let catalogRoot: string | undefined;

  const mockConfig: ValidatedSeptumConfig = {
    version: "1.0",
    settings: {
      enforcement: "strict",
      db_path: ":memory:",
      ignore_patterns: [],
    },
    domains: {
      core: {
        root: "src/core",
        description: "Core domain",
        allowed_dependencies: ["types"],
        forbidden_dependencies: ["mcp", "cli"],
        archetypes: {
          repository: "src/core/database/**",
          service: "src/core/services/**",
        },
      },
      types: {
        root: "src/types",
        description: "Types domain",
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
  });

  afterEach(() => {
    db.close();
    if (catalogRoot) rmSync(catalogRoot,{recursive:true,force:true});
    catalogRoot = undefined;
  });

  describe("1. web-tree-sitter WASM Multi-Language Extraction Without SQL Leakage", () => {
    it("should extract TypeScript AST without leaking SQL VALUES, WHERE, or 'class LIKE' into symbols", async () => {
      const tsCode = `
export class OrderRepository {
  public findOrder(id: string): any {
    const query = "SELECT * FROM orders WHERE id = ? AND status LIKE '%paid%'";
    return null;
  }

  public insertOrder(data: any): void {
    const insertSql = "INSERT INTO orders (id, total) VALUES (?, ?)";
  }
}
`;
      const extractor = new TypeScriptExtractor();
      const ast = await extractor.extract("OrderRepository.ts", tsCode);
      const symbolNames = ast.symbols.map((s) => s.name);

      expect(symbolNames).toContain("OrderRepository");
      expect(symbolNames).toContain("OrderRepository::findOrder");
      expect(symbolNames).toContain("OrderRepository::insertOrder");

      expect(symbolNames.some((n) => n.toUpperCase().includes("VALUES"))).toBe(false);
      expect(symbolNames.some((n) => n.toUpperCase().includes("WHERE"))).toBe(false);
      expect(symbolNames.some((n) => n.includes("class LIKE"))).toBe(false);
    });

    it("should extract PHP AST without leaking SQL strings into symbols or methods", async () => {
      const phpCode = `<?php
namespace App\\Repositories;

class InvoiceRepository {
    public function findPending(): array {
        $sql = "SELECT * FROM invoices WHERE status = 'pending' AND amount > 0";
        return [];
    }

    public function createBatch(): void {
        $insert = "INSERT INTO invoices (total) VALUES (100)";
    }
}
`;
      const extractor = new PHPExtractor();
      const ast = await extractor.extract("InvoiceRepository.php", phpCode);
      const symbolNames = ast.symbols.map((s) => s.name);

      expect(symbolNames).toContain("InvoiceRepository");
      expect(symbolNames).toContain("InvoiceRepository::findPending");
      expect(symbolNames).toContain("InvoiceRepository::createBatch");

      expect(symbolNames.some((n) => n.toUpperCase().includes("VALUES"))).toBe(false);
      expect(symbolNames.some((n) => n.toUpperCase().includes("WHERE"))).toBe(false);
    });

    it("should filter SQL keywords from sibling_methods in handleGetSymbol", async () => {
      const domainId = repo.upsertDomain("core", mockConfig.domains.core);
      const fileId = repo.upsertFile(
        domainId,
        "src/core/OrderRepository.ts",
        "repository",
        "hash_repo_1",
        100,
        Date.now(),
        1000
      );

      repo.replaceFileSymbols(fileId, [
        {
          name: "OrderRepository",
          kind: "class",
          signature: "export class OrderRepository",
          visibility: "public",
          line_start: 1,
          line_end: 100,
          line_count: 100,
        },
        {
          name: "OrderRepository::save",
          kind: "method",
          signature: "public save(): void",
          visibility: "public",
          line_start: 10,
          line_end: 20,
          line_count: 11,
        },
        {
          name: "OrderRepository::VALUES",
          kind: "method",
          signature: "public VALUES(): void",
          visibility: "public",
          line_start: 30,
          line_end: 40,
          line_count: 11,
        },
        {
          name: "OrderRepository::WHERE",
          kind: "method",
          signature: "public WHERE(): void",
          visibility: "public",
          line_start: 50,
          line_end: 60,
          line_count: 11,
        },
      ]);

      const symRes = handleGetSymbol(repo, mockConfig, { symbol: "OrderRepository" });
      const symJson = JSON.parse(symRes.content[0].text);

      expect(symJson.sibling_methods).toBeDefined();
      expect(symJson.sibling_methods).toContain("save");
      expect(symJson.sibling_methods).not.toContain("VALUES");
      expect(symJson.sibling_methods).not.toContain("WHERE");
    });
  });

  describe("2. getSymbolImpact on Named Imports like SymbolRepository", () => {
    it("should track dependents and callers through named imports", async () => {
      const coreDomainId = repo.upsertDomain("core", mockConfig.domains.core);

      // 1. Defining file with SymbolRepository
      const targetFileId = repo.upsertFile(
        coreDomainId,
        "src/core/database/repositories/symbol.repository.ts",
        "repository",
        "hash_sym_def",
        200,
        Date.now(),
        2000
      );
      repo.replaceFileSymbols(targetFileId, [
        {
          name: "SymbolRepository",
          kind: "class",
          signature: "export class SymbolRepository",
          visibility: "public",
          line_start: 10,
          line_end: 150,
          line_count: 141,
        },
      ]);

      // 2. Caller file importing SymbolRepository
      const callerFileId = repo.upsertFile(
        coreDomainId,
        "src/core/database/repository.ts",
        "repository",
        "hash_caller_file",
        100,
        Date.now(),
        1000
      );
      repo.replaceFileDependencies(callerFileId, [
        {
          target: "src/core/database/repositories/symbol.repository.ts",
          statement: 'import { SymbolRepository } from "./repositories/symbol.repository.ts"',
          line_number: 12,
        },
      ]);

      const impactRes = handleGetSymbolImpact(repo, mockConfig, { symbol: "SymbolRepository" });
      const impactBody = JSON.parse(impactRes.content[0].text);

      expect(impactBody.found_in_index).toBe(true);
      expect(impactBody.target_symbol).toBe("SymbolRepository");
      expect(impactBody.impact_summary.total_dependents).toBeGreaterThan(0);
      expect(impactBody.inbound_callers.length).toBeGreaterThan(0);
      expect(
        impactBody.inbound_callers.some((c: any) => c.file === "src/core/database/repository.ts")
      ).toBe(true);
    });
  });

  describe("3. getDomainCatalog Compact Mode + archetype_filter + Bidirectional connections", () => {
    it("should produce compact mode, filter archetypes correctly, and provide bidirectional connections", async () => {
      const coreDomainId = repo.upsertDomain("core", mockConfig.domains.core);

      const repoFileId = repo.upsertFile(
        coreDomainId,
        "src/core/database/repositories/user.repository.ts",
        "repository",
        "hash_repo",
        80,
        Date.now(),
        800
      );
      repo.replaceFileSymbols(repoFileId, [
        {
          name: "UserRepository",
          kind: "class",
          signature: "export class UserRepository",
          visibility: "public",
          line_start: 1,
          line_end: 80,
          line_count: 80,
        },
      ]);

      const serviceFileId = repo.upsertFile(
        coreDomainId,
        "src/core/services/user.service.ts",
        "service",
        "hash_srv",
        120,
        Date.now(),
        1200
      );
      repo.replaceFileSymbols(serviceFileId, [
        {
          name: "UserService",
          kind: "class",
          signature: "export class UserService",
          visibility: "public",
          line_start: 1,
          line_end: 120,
          line_count: 120,
        },
      ]);

      // Service imports Repository
      repo.replaceFileDependencies(serviceFileId, [
        {
          target: "src/core/database/repositories/user.repository.ts",
          statement: 'import { UserRepository } from "../database/repositories/user.repository.ts"',
          line_number: 4,
        },
      ]);

      catalogRoot = mkdtempSync(join(tmpdir(),"septum-catalog-evidence-"));
      const repositorySource = "export class UserRepository {}";
      const serviceSource = 'import { UserRepository } from "../database/repositories/user.repository.ts";\nexport class UserService {}';
      mkdirSync(join(catalogRoot,"src/core/database/repositories"),{recursive:true});
      mkdirSync(join(catalogRoot,"src/core/services"),{recursive:true});
      writeFileSync(join(catalogRoot,"src/core/database/repositories/user.repository.ts"),repositorySource);
      writeFileSync(join(catalogRoot,"src/core/services/user.service.ts"),serviceSource);
      repo.upsertFile(coreDomainId,"src/core/database/repositories/user.repository.ts","repository",computeContentHash(repositorySource),1);
      repo.upsertFile(coreDomainId,"src/core/services/user.service.ts","service",computeContentHash(serviceSource),2);

      // 1. Compact mode check
      const parsedCompact = GetDomainCatalogSchema.parse({ domain: "core", detail_level: "compact" });
      const compactRes = handleGetDomainCatalog(repo, mockConfig, parsedCompact,catalogRoot);
      const compactJson = JSON.parse(compactRes.content[0].text);

      expect(compactJson.detail_level).toBe("compact");
      expect(compactJson.showing_files).toBe(2);

      // Compact symbols should NOT include full properties/methods arrays
      for (const file of compactJson.files) {
        for (const sym of file.symbols) {
          expect(sym.properties).toBeUndefined();
          expect(sym.methods).toBeUndefined();
        }
      }

      // 2. Archetype filter check
      const parsedFilter = GetDomainCatalogSchema.parse({
        domain: "core",
        archetype_filter: "repository",
      });
      const filteredRes = handleGetDomainCatalog(repo, mockConfig, parsedFilter,catalogRoot);
      const filteredJson = JSON.parse(filteredRes.content[0].text);

      expect(filteredJson.showing_files).toBe(1);
      expect(filteredJson.files.every((f: any) => f.archetype === "repository")).toBe(true);
      expect(filteredJson.files[0].path).toBe("src/core/database/repositories/user.repository.ts");

      // 3. Bidirectional connections check
      const userRepoFile = filteredJson.files[0];
      expect(userRepoFile.connections).toBeDefined();
      expect(userRepoFile.connections.imported_by_count).toBe(1);
      expect(Array.isArray(userRepoFile.connections.imports_from)).toBe(true);
    });
  });

  describe("4. check-boundary Repo-Wide Audit & Circular Dependency Detection", () => {
    it("should perform repo-wide boundary audit when called with empty args", async () => {
      repo.upsertDomain("core", mockConfig.domains.core);
      repo.upsertDomain("types", mockConfig.domains.types);
      repo.setMeta("sync_state", "complete");

      const evaluator = new BoundaryEvaluator(repo);
      const res = await handleCheckBoundary(evaluator, mockConfig, {}, repo);
      const body = JSON.parse(res.content[0].text);

      expect(body.status).toBe("approved");
      expect(body.scope).toBe("all");
      expect(body.total_violations).toBe(0);
      expect(body.circular_dependencies_count).toBe(0);
      expect(body.circular_dependencies).toEqual([]);
    });

    it("should detect circular dependencies and report them accurately", async () => {
      const circConfig: ValidatedSeptumConfig = {
        version: "1.0",
        settings: {
          enforcement: "strict",
          db_path: ":memory:",
          ignore_patterns: [],
        },
        domains: {
          alpha: {
            root: "src/domains/alpha",
            description: "Alpha domain",
            allowed_dependencies: [],
            forbidden_dependencies: ["beta"],
            archetypes: {},
          },
          beta: {
            root: "src/domains/beta",
            description: "Beta domain",
            allowed_dependencies: [],
            forbidden_dependencies: ["alpha"],
            archetypes: {},
          },
        },
        features: {},
      };

      const alphaId = repo.upsertDomain("alpha", circConfig.domains.alpha);
      const betaId = repo.upsertDomain("beta", circConfig.domains.beta);
      repo.setMeta("sync_state", "complete");

      const alphaFileId = repo.upsertFile(
        alphaId,
        "src/domains/alpha/AlphaService.ts",
        "service",
        "h_alpha",
        50,
        Date.now(),
        500
      );
      const betaFileId = repo.upsertFile(
        betaId,
        "src/domains/beta/BetaService.ts",
        "service",
        "h_beta",
        50,
        Date.now(),
        500
      );

      // Alpha imports Beta
      repo.replaceFileDependencies(alphaFileId, [
        {
          target: "src/domains/beta/BetaService.ts",
          statement: 'import { BetaService } from "../beta/BetaService.ts"',
          line_number: 1,
        },
      ]);

      // Beta imports Alpha (circular!)
      repo.replaceFileDependencies(betaFileId, [
        {
          target: "src/domains/alpha/AlphaService.ts",
          statement: 'import { AlphaService } from "../alpha/AlphaService.ts"',
          line_number: 1,
        },
      ]);

      const evaluator = new BoundaryEvaluator(repo);
      const res = await handleCheckBoundary(evaluator, circConfig, {}, repo);
      const body = JSON.parse(res.content[0].text);

      expect(body.status).toBe("rejected");
      expect(body.total_violations).toBeGreaterThan(0);
      expect(body.circular_dependencies_count).toBeGreaterThan(0);
      expect(body.circular_dependencies.length).toBeGreaterThan(0);
    });
  });

  describe("5. trace-vertical-slice max_depth Clamping [1, 8]", () => {
    it("should clamp max_depth via TraceVerticalSliceSchema preprocessor", async () => {
      const parsedZero = TraceVerticalSliceSchema.parse({ query: "test", max_depth: 0 });
      expect(parsedZero.max_depth).toBe(1);

      const parsedNegative = TraceVerticalSliceSchema.parse({ query: "test", max_depth: -99 });
      expect(parsedNegative.max_depth).toBe(1);

      const parsedHuge = TraceVerticalSliceSchema.parse({ query: "test", max_depth: 100 });
      expect(parsedHuge.max_depth).toBe(8);

      const parsedNormal = TraceVerticalSliceSchema.parse({ query: "test", max_depth: 6 });
      expect(parsedNormal.max_depth).toBe(6);
    });

    it("should clamp max_depth in handleTraceVerticalSlice execution", async () => {
      // 1. Min clamping test (<= 0 -> 1)
      const resMin = await handleTraceVerticalSlice(repo, mockConfig, {
        query: "GET /api/nonexistent",
        max_depth: 0,
      });
      const jsonMin = JSON.parse(resMin.content[0].text);
      expect(jsonMin.max_depth_applied).toBe(1);

      // 2. Max clamping test (> 8 -> 8)
      const resMax = await handleTraceVerticalSlice(repo, mockConfig, {
        query: "GET /api/nonexistent",
        max_depth: 42,
      });
      const jsonMax = JSON.parse(resMax.content[0].text);
      expect(jsonMax.max_depth_applied).toBe(8);

      // 3. In-range test (4 -> 4)
      const resMid = await handleTraceVerticalSlice(repo, mockConfig, {
        query: "GET /api/nonexistent",
        max_depth: 4,
      });
      const jsonMid = JSON.parse(resMid.content[0].text);
      expect(jsonMid.max_depth_applied).toBe(4);
    });
  });

  describe("6. Agentic Scaffolding Templates & 5-Tool MCP Contracts", () => {
    it("should include all 5 Unified MCP tools in SEPTUM_MAP_SKILL_TEMPLATE with compact mode, max_depth, and circular_dependency", async () => {
      const expectedTools = [
        "septum_domain",
        "septum_symbol",
        "septum_slice",
        "septum_boundary",
        "septum_feature",
      ];

      for (const tool of expectedTools) {
        expect(SEPTUM_MAP_SKILL_TEMPLATE).toContain(tool);
      }

      expect(SEPTUM_MAP_SKILL_TEMPLATE).toContain('detail_level: "compact"');
      expect(SEPTUM_MAP_SKILL_TEMPLATE).toContain("max_depth");
      expect(SEPTUM_MAP_SKILL_TEMPLATE).toContain("circular_dependency");
    });

    it("should include compact mode, max_depth, and circular_dependency in SEPTUM_RULES_TEMPLATE", async () => {
      expect(SEPTUM_RULES_TEMPLATE).toContain('detail_level: "compact"');
      expect(SEPTUM_RULES_TEMPLATE).toContain("max_depth");
      expect(SEPTUM_RULES_TEMPLATE).toContain("circular_dependency");
      expect(SEPTUM_RULES_TEMPLATE).toContain("inbound_callers");
    });

    it("should configure multi-agent hook matchers in SEPTUM_HOOKS_CONFIG", async () => {
      const guard = SEPTUM_HOOKS_CONFIG["septum-boundary-guard"];
      expect(guard).toBeDefined();

      const preMatcher = guard.PreToolUse[0].matcher;
      const postMatcher = guard.PostToolUse[0].matcher;

      const toolsToMatch = [
        "write_to_file",
        "replace_file_content",
        "multi_replace_file_content",
        "Write",
        "Edit",
        "MultiEdit",
      ];

      for (const tool of toolsToMatch) {
        expect(preMatcher).toContain(tool);
        expect(postMatcher).toContain(tool);
      }
    });
  });
});

