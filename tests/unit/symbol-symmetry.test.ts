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
});

