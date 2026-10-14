import { describe, expect, it } from "bun:test";
import {
  DomainToolSchema,
  SymbolToolSchema,
  SliceToolSchema,
  BoundaryToolSchema,
  FeatureToolSchema,
} from "../../src/mcp/schemas.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { handleDomainTool } from "../../src/mcp/tools/domain.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { handleSliceTool } from "../../src/mcp/tools/slice.ts";
import { handleBoundaryTool } from "../../src/mcp/tools/boundary.ts";
import { handleFeatureTool } from "../../src/mcp/tools/feature.ts";

describe("Unified 5 MCP Tools Suite", () => {
  const db = new SeptumDatabase(":memory:");
  const repo = new SeptumRepository(db.raw);
  const config = ConfigLoader.load(undefined, process.cwd());
  const evaluator = new BoundaryEvaluator(repo);

  describe("1. septum_domain (catalog, register, topology)", () => {
    it("should parse default action as catalog", () => {
      const parsed = DomainToolSchema.parse({});
      expect(parsed.action).toBe("catalog");
      expect(parsed.detail_level).toBe("compact");
    });

    it("should infer register action when root is provided", () => {
      const parsed = DomainToolSchema.parse({
        domain: "billing",
        root: "src/billing",
        ingest_now: false,
      });
      expect(parsed.action).toBe("register");
      expect(parsed.domain).toBe("billing");
      expect(parsed.root).toBe("src/billing");
    });

    it("should register domain via handleDomainTool", async () => {
      const res = await handleDomainTool(repo, config, {
        action: "register",
        domain: "orders",
        root: "src/orders",
      });
      expect(res.content[0].text).toContain('"status": "success"');
      expect(res.content[0].text).toContain('"domain": "orders"');
    });

    it("should retrieve domain catalog via handleDomainTool", async () => {
      const res = await handleDomainTool(repo, config, {
        action: "catalog",
        domain: "orders",
      });
      expect(res.content[0].text).toBeDefined();
    });

    it("should retrieve environment topology via handleDomainTool", async () => {
      const res = await handleDomainTool(repo, config, {
        action: "topology",
      });
      expect(res.content[0].text).toContain("Septum Environment & Topology Plane");
    });
  });

  describe("2. septum_symbol (locate, inspect, impact, hotspots)", () => {
    it("should parse default action as locate", () => {
      const parsed = SymbolToolSchema.parse({ query: "OrderService" });
      expect(parsed.action).toBe("locate");
      expect(parsed.query).toBe("OrderService");
    });

    it("should infer hotspots action when min_lines or sort_by is provided", () => {
      const parsed = SymbolToolSchema.parse({ min_lines: 50 });
      expect(parsed.action).toBe("hotspots");
      expect(parsed.min_lines).toBe(50);
    });

    it("should execute hotspots via handleSymbolTool", async () => {
      const res = await handleSymbolTool(repo, config, {
        action: "hotspots",
        min_lines: 10,
      });
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.threshold_min_lines).toBe(10);
      expect(Array.isArray(parsed.hotspots)).toBe(true);
    });

    it("should execute locate and impact via handleSymbolTool", async () => {
      const locateRes = await handleSymbolTool(repo, config, {
        action: "locate",
        query: "calculateTotal",
      });
      expect(locateRes.content[0].text).toBeDefined();

      const impactRes = await handleSymbolTool(repo, config, {
        action: "impact",
        query: "calculateTotal",
      });
      expect(impactRes.content[0].text).toBeDefined();
    });
  });

  describe("3. septum_slice", () => {
    it("should parse slice query and clamp depth", () => {
      const parsed = SliceToolSchema.parse({
        query: "POST /orders",
        max_depth: 10,
      });
      expect(parsed.query).toBe("POST /orders");
      expect(parsed.max_depth).toBe(8);
    });

    it("should execute trace slice via handleSliceTool", () => {
      const res = handleSliceTool(repo, config, {
        query: "POST /api/orders",
      });
      expect(res.content[0].text).toBeDefined();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.query).toBe("POST /api/orders");
    });
  });

  describe("4. septum_boundary", () => {
    it("should parse boundary check args", () => {
      const parsed = BoundaryToolSchema.parse({
        file_path: "src/orders/service.ts",
        proposed_imports: ["src/billing/service.ts"],
      });
      expect(parsed.file_path).toBe("src/orders/service.ts");
      expect(parsed.proposed_imports).toContain("src/billing/service.ts");
    });

    it("should audit boundaries via handleBoundaryTool", async () => {
      const res = await handleBoundaryTool(evaluator, config, {
        file_path: "src/orders/service.ts",
        proposed_imports: [],
      }, repo);
      expect(res.content[0].text).toBeDefined();
    });
  });

  describe("5. septum_feature (get, lock, release)", () => {
    it("should parse default action as get", () => {
      const parsed = FeatureToolSchema.parse({ feature_key: "checkout" });
      expect(parsed.action).toBe("get");
      expect(parsed.feature_key).toBe("checkout");
    });

    it("should infer lock action when allowed_touchpoints is passed", () => {
      const parsed = FeatureToolSchema.parse({
        feature_key: "checkout",
        domain: "orders",
        allowed_touchpoints: ["src/orders/checkout.ts"],
      });
      expect(parsed.action).toBe("lock");
    });

    it("should lock, get, and release feature context via handleFeatureTool", async () => {
      const lockRes = await handleFeatureTool(repo, config, {
        action: "lock",
        feature_key: "checkout_v2",
        domain: "orders",
        allowed_touchpoints: ["src/orders/checkout.ts"],
      });
      expect(lockRes.content[0].text).toContain('"status": "success"');

      const getRes = await handleFeatureTool(repo, config, {
        action: "get",
        feature_key: "checkout_v2",
      });
      expect(getRes.content[0].text).toContain("checkout_v2");

      const releaseRes = await handleFeatureTool(repo, config, {
        action: "release",
      });
      expect(releaseRes.content[0].text).toContain("released");
    });
  });
});
