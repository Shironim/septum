import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { handleRegisterFeature } from "../../src/mcp/tools/register-feature.ts";
import { handleGetFeatureContext } from "../../src/mcp/tools/get-feature-context.ts";
import { SessionManager } from "../../src/core/session/session-manager.ts";
import {
  GetFeatureContextSchema,
  RegisterFeatureSchema,
  normalizeFeatureContextArgs,
  normalizeRegisterFeatureArgs,
} from "../../src/mcp/schemas.ts";

describe("Dynamic Feature Registration & Auto-Derive Fallback", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let tempDir: string;
  let mockConfig: ValidatedSeptumConfig;

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-feat-test-"));

    mockConfig = {
      version: "1.0",
      settings: {
        enforcement: "strict",
        db_path: ":memory:",
        ignore_patterns: [],
      },
      domains: {
        penjualan: {
          root: "app/Domain/Penjualan",
          description: "Domain Penjualan POS",
          allowed_dependencies: [],
          forbidden_dependencies: [],
          archetypes: {},
        },
      },
      features: {},
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("handleRegisterFeature", () => {
    it("should reject registration if required args are missing", async () => {
      // @ts-expect-error test missing args
      expect(handleRegisterFeature(repo, mockConfig, { feature_key: "" })).rejects.toThrow(
        "Missing required arguments"
      );
    });

    it("should register feature in memory and create active session lease", async () => {
      const res = await handleRegisterFeature(
        repo,
        mockConfig,
        {
          feature_key: "pos-kasir",
          domain: "penjualan",
          description: "Kasir POS endpoint",
          allowed_touchpoints: ["app/Http/Controllers/PenjualanController.php"],
          reuse_symbols: ["PenjualanService"],
        },
        tempDir
      );

      expect(mockConfig.features["pos-kasir"]).toBeDefined();
      expect(mockConfig.features["pos-kasir"].domain).toBe("penjualan");

      // Verify active session lease was saved
      const session = SessionManager.getActiveSession(tempDir);
      expect(session).not.toBeNull();
      expect(session?.feature_key).toBe("pos-kasir");
      expect(session?.touchpoints).toContain("app/Http/Controllers/PenjualanController.php");

      // Verify tool returned success
      const json = JSON.parse(res.content[0].text);
      expect(json.status).toBe("success");
      expect(json.feature_key).toBe("pos-kasir");
    });

    it("should persist to septum.config.json if persist_to_config is true", async () => {
      const configPath = path.join(tempDir, "septum.config.json");
      fs.writeFileSync(configPath, JSON.stringify({ version: "1.0", domains: {} }), "utf-8");

      await handleRegisterFeature(
        repo,
        mockConfig,
        {
          feature_key: "laporan-harian",
          domain: "penjualan",
          allowed_touchpoints: ["app/Reports/DailyReport.php"],
          persist_to_config: true,
        },
        tempDir
      );

      const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(written.features?.["laporan-harian"]).toBeDefined();
      expect(written.features?.["laporan-harian"].domain).toBe("penjualan");
    });
  });

  describe("handleGetFeatureContext auto-derive fallback", () => {
    it("should fetch registered feature context normally", () => {
      mockConfig.features["penjualan"] = {
        domain: "penjualan",
        description: "Fitur penjualan",
        allowed_touchpoints: ["app/Http/Controllers/PenjualanController.php"],
        reuse_symbols: [],
      };

      const res = handleGetFeatureContext(repo, mockConfig, { feature_key: "penjualan" }, tempDir);
      const data = JSON.parse(res.content[0].text);
      expect(data.feature_key).toBe("penjualan");
      expect(data.feature).toBe("penjualan");
      expect(data.domain).toBe("penjualan");
      expect(data.is_inferred).toBeFalsy();
    });

    it("should auto-derive feature context from vertical slices if not registered", () => {
      // Upsert a vertical slice matching 'penjualan'
      repo.upsertVerticalSlice({
        http_method: "GET",
        route_uri: "/penjualan",
        route_name: "penjualan.index",
        controller_class: "App\\Http\\Controllers\\PenjualanController",
        action_name: "index",
        controller_file: "app/Http/Controllers/PenjualanController.php",
        controller_line: 15,
        architecture_style: "mvc",
        entry_kind: "http_route",
        execution_chain_json: JSON.stringify([
          { stage: "ingress", symbol: "GET /penjualan" },
          { stage: "controller", symbol: "PenjualanController::index", file: "app/Http/Controllers/PenjualanController.php" },
          { stage: "egress", symbol: "resources/js/Pages/Penjualan/Index.vue", file: "resources/js/Pages/Penjualan/Index.vue" },
        ]),
      });

      // Feature 'penjualan' is not in mockConfig.features!
      expect(mockConfig.features["penjualan"]).toBeUndefined();

      const res = handleGetFeatureContext(repo, mockConfig, { feature_key: "penjualan" }, tempDir);
      const data = JSON.parse(res.content[0].text);

      expect(data.feature_key).toBe("penjualan");
      expect(data.feature).toBe("penjualan");
      expect(data.is_inferred).toBe(true);
      expect(data.allowed_touchpoints).toContain("app/Http/Controllers/PenjualanController.php");
      expect(data.allowed_touchpoints).toContain("resources/js/Pages/Penjualan/Index.vue");
      expect(data.reuse_symbols.some((s: any) => s.name.includes("PenjualanController"))).toBe(true);

      // Verify active session was leased
      const session = SessionManager.getActiveSession(tempDir);
      expect(session).not.toBeNull();
      expect(session?.feature_key).toBe("penjualan");
    });

    it("should throw actionable error if feature not found and cannot be auto-derived", () => {
      expect(() => {
        handleGetFeatureContext(repo, mockConfig, { feature: "nonexistent-feature" }, tempDir);
      }).toThrow(/Feature 'nonexistent-feature' not found in configuration/);

      try {
        handleGetFeatureContext(repo, mockConfig, { feature: "nonexistent-feature" }, tempDir);
      } catch (err: any) {
        expect(err.message).toContain("▶ RECOVERY OPTIONS:");
        expect(err.message).toContain("septum_register_feature");
        expect(err.message).toContain("septum_trace_vertical_slice");
      }
    });

    it("should gracefully handle zero-argument calls by returning catalog guidance instead of throwing", () => {
      mockConfig.features["penjualan"] = {
        domain: "penjualan",
        allowed_touchpoints: ["app/Http/Controllers/PenjualanController.php"],
      };

      const res = handleGetFeatureContext(repo, mockConfig, {}, tempDir);
      const data = JSON.parse(res.content[0].text);
      expect(data.status).toBe("prompt");
      expect(data.message).toContain("No feature specified");
      expect(data.available_features).toContain("penjualan");
      expect(data.instructions).toBeDefined();
    });
  });

  describe("Fault-Tolerant Schema Normalization & Contract Symmetry", () => {
    it("should normalize bare string or single-item array into feature_key and feature", () => {
      const fromBareString = normalizeFeatureContextArgs("checkout");
      expect(fromBareString).toEqual({ feature: "checkout", feature_key: "checkout" });

      const fromArray = normalizeFeatureContextArgs(["checkout"]);
      expect(fromArray).toEqual({ feature: "checkout", feature_key: "checkout" });
    });

    it("should normalize diverse LLM alias keys (feature_name, task, feat, key) to canonical feature", () => {
      const fromFeatureName = normalizeFeatureContextArgs({ feature_name: "checkout_flow" });
      expect((fromFeatureName as any).feature).toBe("checkout_flow");
      expect((fromFeatureName as any).feature_key).toBe("checkout_flow");

      const fromTask = normalizeFeatureContextArgs({ task: "checkout_flow" });
      expect((fromTask as any).feature).toBe("checkout_flow");

      const fromFeat = normalizeFeatureContextArgs({ feat: "checkout_flow" });
      expect((fromFeat as any).feature).toBe("checkout_flow");
    });

    it("should fallback to single string property if unknown key is sent", () => {
      const fromUnknownKey = normalizeFeatureContextArgs({ arbitrary_intent: "checkout_flow" });
      expect((fromUnknownKey as any).feature).toBe("checkout_flow");
      expect((fromUnknownKey as any).feature_key).toBe("checkout_flow");
    });

    it("should validate and coerce RegisterFeatureSchema with symmetrical aliases and touchpoints", () => {
      const parsed = RegisterFeatureSchema.safeParse({
        feature: "retur_barang",
        domain_name: "penjualan",
        touchpoints: "app/Services/ReturService.php",
        reuse: "PenjualanService",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.feature_key).toBe("retur_barang");
        expect(parsed.data.feature).toBe("retur_barang");
        expect(parsed.data.domain).toBe("penjualan");
        expect(parsed.data.domain_name).toBe("penjualan");
        expect(parsed.data.allowed_touchpoints).toEqual(["app/Services/ReturService.php"]);
        expect(parsed.data.reuse_symbols).toEqual(["PenjualanService"]);
      }
    });

    it("should parse zero-arg and flexible inputs through GetFeatureContextSchema safely", () => {
      const emptyParsed = GetFeatureContextSchema.safeParse({});
      expect(emptyParsed.success).toBe(true);

      const bareParsed = GetFeatureContextSchema.safeParse("pos-kasir");
      expect(bareParsed.success).toBe(true);
      if (bareParsed.success) {
        expect(bareParsed.data.feature).toBe("pos-kasir");
        expect(bareParsed.data.feature_key).toBe("pos-kasir");
      }
    });
  });
});
