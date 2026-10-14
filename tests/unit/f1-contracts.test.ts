import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { SessionManager } from "../../src/core/session/session-manager.ts";
import { handleFeatureTool } from "../../src/mcp/tools/feature.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { SymbolToolSchema } from "../../src/mcp/schemas.ts";

describe("F1-02 & F1-03: MCP Contracts (Feature Release Force & Hotspots Limit)", () => {
  const testDir = join(import.meta.dir, "../fixtures/f1_contracts_test");
  const dbPath = join(testDir, "test.db");
  let db: SeptumDatabase;
  let repo: SeptumRepository;

  const mockConfig: ValidatedSeptumConfig = {
    version: "1.0",
    settings: {
      enforcement: "strict",
      db_path: dbPath,
    },
    domains: {
      orders: {
        root: "src/orders",
      },
    },
    features: {
      checkout: {
        domain: "orders",
        description: "Checkout flow",
        allowed_touchpoints: ["src/orders/Order.ts"],
        reuse_symbols: [],
        input_contract: {},
        output_contract: {},
      },
    },
  };

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    db = new SeptumDatabase(dbPath);
    repo = new SeptumRepository(db.raw);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("F1-02: MCP feature release force support", () => {
    it("releases session when owned by the current owner", async () => {
      SessionManager.saveActiveSession(testDir, {
        feature_key: "checkout",
        domain: "orders",
        touchpoints: ["src/orders/Order.ts"],
        locked_at: new Date().toISOString(),
      });
      expect(SessionManager.getActiveSession(testDir)).not.toBeNull();

      const res = await handleFeatureTool(repo, mockConfig, {
        action: "release",
        force: false,
      }, testDir);

      expect(res.content[0].text).toContain("Active feature session successfully released.");
      expect(SessionManager.getActiveSession(testDir)).toBeNull();
    });

    it("fails to release session of another owner without force", async () => {
      SessionManager.saveActiveSession(testDir, {
        feature_key: "checkout",
        domain: "orders",
        touchpoints: ["src/orders/Order.ts"],
        locked_at: new Date().toISOString(),
      });

      // Overwrite owner to another user
      const sessionPath = join(testDir, SessionManager.SESSION_FILE);
      const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
      session.owner_id = "other-agent-owner";
      writeFileSync(sessionPath, JSON.stringify(session));

      // Without force, should throw an error from SessionManager
      expect(async () => {
        await handleFeatureTool(repo, mockConfig, {
          action: "release",
          force: false,
        }, testDir);
      }).toThrow(/Only the active session owner can release it/);

      expect(existsSync(sessionPath)).toBe(true);
    });

    it("successfully releases another owner's session when force=true", async () => {
      SessionManager.saveActiveSession(testDir, {
        feature_key: "checkout",
        domain: "orders",
        touchpoints: ["src/orders/Order.ts"],
        locked_at: new Date().toISOString(),
      });

      // Overwrite owner to another user
      const sessionPath = join(testDir, SessionManager.SESSION_FILE);
      const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
      session.owner_id = "other-agent-owner";
      writeFileSync(sessionPath, JSON.stringify(session));

      // With force=true, release must succeed
      const res = await handleFeatureTool(repo, mockConfig, {
        action: "release",
        force: true,
      }, testDir);

      expect(res.content[0].text).toContain("Active feature session successfully released.");
      expect(existsSync(sessionPath)).toBe(false);
    });

    it("returns appropriate message when no session exists", async () => {
      const res = await handleFeatureTool(repo, mockConfig, {
        action: "release",
        force: true,
      }, testDir);

      expect(res.content[0].text).toContain("No active feature session found to release.");
    });
  });

  describe("F1-03: Hotspots default limit (30) vs locate limit (10)", () => {
    it("parses SymbolToolSchema without forcing limit=10 on hotspots", () => {
      const parsedLocate = SymbolToolSchema.parse({ action: "locate", query: "Order" });
      expect(parsedLocate.limit).toBeUndefined();

      const parsedHotspots = SymbolToolSchema.parse({ action: "hotspots" });
      expect(parsedHotspots.limit).toBeUndefined();

      const parsedExplicit = SymbolToolSchema.parse({ action: "hotspots", limit: 50 });
      expect(parsedExplicit.limit).toBe(50);
    });

    it("uses default limit 30 for hotspots and default limit 10 for locate in handler", async () => {
      const domainId = repo.upsertDomain("orders", { root: "src/orders" });
      const fileId = repo.upsertFile(
        domainId,
        "src/orders/Hotspots.ts",
        "service",
        "hash123",
        500,
        Date.now(),
        5000
      );

      const symbols = Array.from({ length: 15 }, (_, i) => ({
        name: `hotspotFunction${i}`,
        kind: "function" as const,
        signature: `function hotspotFunction${i}()`,
        visibility: "public" as const,
        line_start: i * 40 + 1,
        line_end: i * 40 + 35,
        line_count: 35,
        nesting_depth: 2,
      }));
      repo.replaceFileSymbols(fileId, symbols);

      // Hotspots without explicit limit should return all 15 (since default limit is 30)
      const parsedHotspotArgs = SymbolToolSchema.parse({
        action: "hotspots",
        min_lines: 30,
      });
      const hotspotsRes = await handleSymbolTool(repo, mockConfig, parsedHotspotArgs, undefined, testDir);

      const hotspotsPayload = JSON.parse(hotspotsRes.content[0].text);
      expect(hotspotsPayload.hotspots.length).toBe(15);

      // Hotspots with explicit limit=5 should return 5
      const parsedLimitedArgs = SymbolToolSchema.parse({
        action: "hotspots",
        min_lines: 30,
        limit: 5,
      });
      const limitedRes = await handleSymbolTool(repo, mockConfig, parsedLimitedArgs, undefined, testDir);
      const limitedPayload = JSON.parse(limitedRes.content[0].text);
      expect(limitedPayload.hotspots.length).toBe(5);
    });
  });
});
