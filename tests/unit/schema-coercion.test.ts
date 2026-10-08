import { describe, expect, it } from "bun:test";
import {
  CheckBoundarySchema,
  GetDomainCatalogSchema,
  GetSymbolImpactSchema,
  GetSymbolSchema,
  LocateSymbolSchema,
  TraceVerticalSliceSchema,
} from "../../src/mcp/schemas.ts";

describe("Universal Single-Arity Schema Coercion", () => {
  describe("LocateSymbolSchema Coercion", () => {
    it("coerces a bare string into query and symbol properties", () => {
      const parsed = LocateSymbolSchema.safeParse("OrderService");
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.query).toBe("OrderService");
        expect(parsed.data.symbol).toBe("OrderService");
      }
    });

    it("coerces a single-element string array into query", () => {
      const parsed = LocateSymbolSchema.safeParse(["OrderService::cancelOrder"]);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.query).toBe("OrderService::cancelOrder");
      }
    });

    it("coerces a single unknown string property object into query", () => {
      const parsed = LocateSymbolSchema.safeParse({ method_name: "calculateTotal" });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.query).toBe("calculateTotal");
      }
    });
  });

  describe("GetSymbolSchema Coercion", () => {
    it("coerces a bare string into symbol and query properties", () => {
      const parsed = GetSymbolSchema.safeParse("OrderService::find");
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.symbol).toBe("OrderService::find");
        expect(parsed.data.query).toBe("OrderService::find");
        expect(parsed.data.include_dependencies).toBe(true);
      }
    });

    it("coerces a single-element string array into symbol", () => {
      const parsed = GetSymbolSchema.safeParse(["App\\Models\\User"]);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.symbol).toBe("App\\Models\\User");
      }
    });
  });

  describe("GetSymbolImpactSchema Coercion", () => {
    it("coerces a bare string into symbol and query properties", () => {
      const parsed = GetSymbolImpactSchema.safeParse("OrderService");
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.symbol).toBe("OrderService");
        expect(parsed.data.query).toBe("OrderService");
      }
    });

    it("coerces a single-element string array into symbol", () => {
      const parsed = GetSymbolImpactSchema.safeParse(["OrderService"]);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.symbol).toBe("OrderService");
      }
    });
  });

  describe("TraceVerticalSliceSchema Coercion", () => {
    it("coerces a bare route URI string into query", () => {
      const parsed = TraceVerticalSliceSchema.safeParse("POST /api/orders");
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.query).toBe("POST /api/orders");
        expect(parsed.data.max_depth).toBe(5);
      }
    });

    it("coerces a single-element array with action string into query", () => {
      const parsed = TraceVerticalSliceSchema.safeParse(["OrderController@store"]);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.query).toBe("OrderController@store");
      }
    });
  });

  describe("GetDomainCatalogSchema Coercion", () => {
    it("coerces a bare domain name string into domain and name properties", () => {
      const parsed = GetDomainCatalogSchema.safeParse("orders");
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.domain).toBe("orders");
        expect(parsed.data.name).toBe("orders");
      }
    });

    it("coerces a single-element string array into domain", () => {
      const parsed = GetDomainCatalogSchema.safeParse(["billing"]);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.domain).toBe("billing");
      }
    });
  });

  describe("CheckBoundarySchema Coercion", () => {
    it("coerces a bare file path string into file_path", () => {
      const parsed = CheckBoundarySchema.safeParse("app/Models/Order.php");
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.file_path).toBe("app/Models/Order.php");
        expect(parsed.data.proposed_imports).toEqual([]);
      }
    });

    it("coerces a single-element array into file_paths", () => {
      const parsed = CheckBoundarySchema.safeParse(["app/Models/Order.php"]);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.file_path).toBe("app/Models/Order.php");
      }
    });
  });
});

