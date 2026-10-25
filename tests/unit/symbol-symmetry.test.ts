import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import {
  GetSymbolImpactSchema,
  GetSymbolSchema,
  LocateSymbolSchema,
  TraceVerticalSliceSchema,
} from "../../src/mcp/schemas.ts";
import { handleGetSymbol } from "../../src/mcp/tools/get-symbol.ts";
import { handleGetSymbolImpact } from "../../src/mcp/tools/get-symbol-impact.ts";
import { handleLocateSymbol } from "../../src/mcp/tools/locate-symbol.ts";

describe("Symbol & Query Parameter Symmetry", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;

  const mockConfig: ValidatedSeptumConfig = {
    version: "1.0",
    settings: {
      enforcement: "strict",
      db_path: ":memory:",
      ignore_patterns: [],
    },
    domains: {},
    features: {},
  };

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
  });

  afterEach(() => {
    db.close();
  });

  describe("Schema-Level Symmetrical Mapping", () => {
    it("LocateSymbolSchema mirrors 'symbol' input to 'query'", () => {
      const parsed = LocateSymbolSchema.safeParse({ symbol: "OrderService::cancel" });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.query).toBe("OrderService::cancel");
        expect(parsed.data.symbol).toBe("OrderService::cancel");
      }
    });

    it("LocateSymbolSchema mirrors 'query' input to 'symbol'", () => {
      const parsed = LocateSymbolSchema.safeParse({ query: "OrderService::cancel" });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.query).toBe("OrderService::cancel");
        expect(parsed.data.symbol).toBe("OrderService::cancel");
      }
    });

    it("GetSymbolSchema mirrors 'query' input to 'symbol'", () => {
      const parsed = GetSymbolSchema.safeParse({ query: "OrderRepository" });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.symbol).toBe("OrderRepository");
        expect(parsed.data.query).toBe("OrderRepository");
      }
    });

    it("GetSymbolImpactSchema mirrors 'query' input to 'symbol'", () => {
      const parsed = GetSymbolImpactSchema.safeParse({ query: "OrderRepository" });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.symbol).toBe("OrderRepository");
        expect(parsed.data.query).toBe("OrderRepository");
      }
    });

    it("TraceVerticalSliceSchema mirrors 'symbol' input to 'query'", () => {
      const parsed = TraceVerticalSliceSchema.safeParse({ symbol: "OrderController@index" });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.query).toBe("OrderController@index");
        expect(parsed.data.symbol).toBe("OrderController@index");
      }
    });
  });

  describe("Handler-Level Runtime Fallback Symmetry", () => {
    it("handleGetSymbol resolves successfully when caller provides 'query' instead of 'symbol'", () => {
      // @ts-expect-error test fallback
      const result = handleGetSymbol(repo, mockConfig, { query: "MissingEntity" });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.found).toBe(false);
      expect(payload.symbol).toBe("MissingEntity");
      expect(payload.message).toContain("MissingEntity");
    });

    it("handleGetSymbolImpact resolves successfully when caller provides 'query' instead of 'symbol'", () => {
      // @ts-expect-error test fallback
      const result = handleGetSymbolImpact(repo, mockConfig, { query: "MissingEntity" });
      const payload = JSON.parse(result.content[0].text);

      expect(payload.target_symbol).toBe("MissingEntity");
      expect(payload.found_in_index).toBe(false);
    });

    it("handleLocateSymbol resolves successfully when caller provides 'symbol' instead of 'query'", async () => {
      const result = await handleLocateSymbol(repo, mockConfig, {
        symbol: "MissingEntity",
      });

      expect(result.content[0].type).toBe("text");
      const json = JSON.parse(result.content[0].text);
      expect(json.found).toBe(false);
      expect(json.status).toBe("not_found");
    });
  });

  describe("PHP Namespace Search Normalization (PHP-01)", () => {
    beforeEach(() => {
      const domainId = repo.upsertDomain("billing", { root: "src/billing" });
      const fileId = repo.upsertFile(domainId, "src/billing/OrderController.php", "controller", "dummyhash", 30);
      repo.replaceFileSymbols(fileId, [
        {
          name: "App\\Http\\Controllers\\OrderController",
          kind: "class",
          signature: "class OrderController",
          visibility: "public",
          line_start: 5,
          line_end: 25,
          line_count: 21,
        },
        {
          name: "App\\Http\\Controllers\\OrderController::index",
          kind: "method",
          signature: "public function index(): void",
          visibility: "public",
          line_start: 10,
          line_end: 15,
          line_count: 6,
        },
      ]);
    });

    it("matches symbols queried with full namespace", () => {
      const matches = repo.findSymbolsByName("App\\Http\\Controllers\\OrderController::index");
      expect(matches.length).toBe(1);
      expect(matches[0].name).toBe("App\\Http\\Controllers\\OrderController::index");
    });

    it("matches symbols queried with un-namespaced Class::method", () => {
      const matches = repo.findSymbolsByName("OrderController::index");
      expect(matches.length).toBe(1);
      expect(matches[0].name).toBe("App\\Http\\Controllers\\OrderController::index");
    });

    it("matches class queried with bare short name", () => {
      const matches = repo.findSymbolsByName("OrderController");
      expect(matches.length).toBe(1);
      expect(matches[0].name).toBe("App\\Http\\Controllers\\OrderController");
    });

    it("matches method queried with bare function name", () => {
      const matches = repo.findSymbolsByName("index");
      expect(matches.length).toBe(1);
      expect(matches[0].name).toBe("App\\Http\\Controllers\\OrderController::index");
    });

    it("returns empty when query does not match", () => {
      const matches = repo.findSymbolsByName("UserController");
      expect(matches.length).toBe(0);
    });
  });

  describe("Go Receiver & Method Disambiguation (GO-01)", () => {
    beforeEach(() => {
      const domainId = repo.upsertDomain("billing", { root: "src/billing" });
      const fileId = repo.upsertFile(domainId, "src/billing/handlers.go", "handler", "gohash", 60);
      repo.replaceFileSymbols(fileId, [
        {
          name: "OrderHandler",
          kind: "struct",
          signature: "type OrderHandler struct",
          visibility: "public",
          line_start: 5,
          line_end: 10,
          line_count: 6,
        },
        {
          name: "UserHandler",
          kind: "struct",
          signature: "type UserHandler struct",
          visibility: "public",
          line_start: 12,
          line_end: 17,
          line_count: 6,
        },
        {
          name: "Create",
          kind: "method",
          signature: "func (h *OrderHandler) Create()",
          visibility: "public",
          line_start: 20,
          line_end: 25,
          line_count: 6,
        },
        {
          name: "Create",
          kind: "method",
          signature: "func (h *UserHandler) Create()",
          visibility: "public",
          line_start: 30,
          line_end: 35,
          line_count: 6,
        },
        {
          name: "Find",
          kind: "method",
          signature: "func (r *Repo[T, U]) Find() *T",
          visibility: "public",
          line_start: 40,
          line_end: 45,
          line_count: 6,
        },
      ]);
    });

    it("disambiguates duplicate method names using Type.Method syntax", () => {
      const orderMatches = repo.findSymbolsByName("OrderHandler.Create");
      expect(orderMatches.length).toBe(1);
      expect(orderMatches[0].symbol_ref.container).toBe("OrderHandler");
      expect(orderMatches[0].symbol_ref.receiver).toBe("*OrderHandler");

      const userMatches = repo.findSymbolsByName("UserHandler.Create");
      expect(userMatches.length).toBe(1);
      expect(userMatches[0].symbol_ref.container).toBe("UserHandler");
      expect(userMatches[0].symbol_ref.receiver).toBe("*UserHandler");
    });

    it("disambiguates duplicate method names using Type::Method syntax", () => {
      const orderMatches = repo.findSymbolsByName("OrderHandler::Create");
      expect(orderMatches.length).toBe(1);
      expect(orderMatches[0].symbol_ref.container).toBe("OrderHandler");
    });

    it("matches pointer receiver syntax (*Type)::Method", () => {
      const orderMatches = repo.findSymbolsByName("(*OrderHandler)::Create");
      expect(orderMatches.length).toBe(1);
      expect(orderMatches[0].symbol_ref.container).toBe("OrderHandler");
    });

    it("returns both candidates when queried with bare method name", () => {
      const matches = repo.findSymbolsByName("Create");
      expect(matches.length).toBe(2);
      const containers = matches.map((m) => m.symbol_ref.container).sort();
      expect(containers).toEqual(["OrderHandler", "UserHandler"]);
    });

    it("resolves multi-parameter generic receivers without losing container", () => {
      const repoMatches = repo.findSymbolsByName("Repo.Find");
      expect(repoMatches.length).toBe(1);
      expect(repoMatches[0].symbol_ref.container).toBe("Repo");
      expect(repoMatches[0].symbol_ref.receiver).toBe("*Repo[T, U]");
    });
  });
});

