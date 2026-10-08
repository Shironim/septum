import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { handleGetDomainCatalog } from "../../src/mcp/tools/get-domain-catalog.ts";
import { handleLocateSymbol } from "../../src/mcp/tools/locate-symbol.ts";
import { handleGetSymbol } from "../../src/mcp/tools/get-symbol.ts";
import { handleTraceVerticalSlice } from "../../src/mcp/tools/trace-vertical-slice.ts";
import { handleGetSymbolImpact } from "../../src/mcp/tools/get-symbol-impact.ts";

describe("Unified Not-Found Protocol & Recovery Guidance Resilience", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let mockConfig: ValidatedSeptumConfig;

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    mockConfig = {
      version: "1.0",
      settings: {
        enforcement: "strict",
        db_path: ":memory:",
        ignore_patterns: [],
      },
      domains: {
        orders: {
          root: "src/domains/orders",
          description: "Orders domain",
          allowed_dependencies: [],
          forbidden_dependencies: [],
          archetypes: {},
        },
        billing: {
          root: "src/domains/billing",
          description: "Billing domain",
          allowed_dependencies: [],
          forbidden_dependencies: [],
          archetypes: {},
        },
      },
      features: {},
    };
  });

  afterEach(() => {
    db.close();
  });

  describe("handleGetDomainCatalog Not-Found Protocol", () => {
    it("returns structured JSON with found: false, suggestions, and recovery action instead of throwing", () => {
      const result = handleGetDomainCatalog(repo, mockConfig, { domain: "order" });

      expect(result.content[0].type).toBe("text");
      const json = JSON.parse(result.content[0].text);

      expect(json.status).toBe("not_found");
      expect(json.found).toBe(false);
      expect(json.domain).toBe("order");
      expect(json.message).toContain("not found in Septum catalog");
      expect(Array.isArray(json.suggestions)).toBe(true);
      expect(json.suggestions).toContain("orders");
      expect(json.suggested_action.tool).toBe("septum_register_domain");
    });
  });

  describe("handleLocateSymbol Not-Found Protocol", () => {
    it("returns structured JSON with found: false, suggestions, and summary when symbol is not found", async () => {
      const result = await handleLocateSymbol(repo, mockConfig, {
        query: "UnknownPaymentProcessor",
      });

      expect(result.content[0].type).toBe("text");
      const json = JSON.parse(result.content[0].text);

      expect(json.status).toBe("not_found");
      expect(json.found).toBe(false);
      expect(json.query).toBe("UnknownPaymentProcessor");
      expect(Array.isArray(json.suggestions)).toBe(true);
      expect(json.summary).toContain("[NOT FOUND]");
      expect(json.message).toBeDefined();
    });
  });

  describe("handleGetSymbol Not-Found Protocol", () => {
    it("returns structured JSON with found: false and ranked suggestions", () => {
      const result = handleGetSymbol(repo, mockConfig, {
        symbol: "MissingOrderHandler",
      });

      expect(result.content[0].type).toBe("text");
      const json = JSON.parse(result.content[0].text);

      expect(json.found).toBe(false);
      expect(json.symbol).toBe("MissingOrderHandler");
      expect(Array.isArray(json.suggestions)).toBe(true);
      expect(json.message).toContain("was not found in the deterministic catalog");
    });
  });

  describe("handleTraceVerticalSlice Not-Found Protocol", () => {
    it("returns structured JSON with found: false and alternatives list", () => {
      const result = handleTraceVerticalSlice(repo, mockConfig, {
        query: "POST /unregistered/route",
      });

      expect(result.content[0].type).toBe("text");
      const json = JSON.parse(result.content[0].text);

      expect(json.status).toBe("not_found");
      expect(json.found).toBe(false);
      expect(json.query).toBe("POST /unregistered/route");
      expect(json.summary).toContain("[NOT FOUND]");
      expect(Array.isArray(json.alternatives)).toBe(true);
    });
  });

  describe("handleGetSymbolImpact Not-Found Protocol", () => {
    it("returns structured JSON with found_in_index: false and zero dependents", () => {
      const result = handleGetSymbolImpact(repo, mockConfig, {
        symbol: "GhostSymbol",
      });

      expect(result.content[0].type).toBe("text");
      const json = JSON.parse(result.content[0].text);

      expect(json.target_symbol).toBe("GhostSymbol");
      expect(json.found_in_index).toBe(false);
      expect(json.impact_summary.total_dependents).toBe(0);
      expect(json.inbound_callers).toEqual([]);
    });
  });
});

