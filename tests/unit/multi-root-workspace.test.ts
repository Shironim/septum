import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { handleRegisterFeature } from "../../src/mcp/tools/register-feature.ts";
import { handleRegisterDomain } from "../../src/mcp/tools/register-domain.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/check-boundary.ts";
import { handleTraceVerticalSlice } from "../../src/mcp/tools/trace-vertical-slice.ts";
import { extractPathHint } from "../../src/mcp/server.ts";

describe("Multi-Root Workspace Resolution & WorkspaceRoot Propagation", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let tempWorkspace1: string;
  let tempWorkspace2: string;
  let mockConfig: ValidatedSeptumConfig;

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);

    tempWorkspace1 = fs.mkdtempSync(path.join(os.tmpdir(), "septum-ws1-"));
    tempWorkspace2 = fs.mkdtempSync(path.join(os.tmpdir(), "septum-ws2-"));

    mockConfig = {
      version: "1.0",
      settings: {
        enforcement: "strict",
        db_path: ":memory:",
        ignore_patterns: [],
      },
      domains: {
        orders: {
          root: "packages/orders",
          description: "Orders domain package",
          allowed_dependencies: [],
          forbidden_dependencies: ["billing"],
          archetypes: {},
        },
      },
      features: {},
    };
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tempWorkspace1, { recursive: true, force: true });
      fs.rmSync(tempWorkspace2, { recursive: true, force: true });
    } catch {}
  });

  it("handleRegisterFeature writes .septum/session.json into the provided workspaceRoot", async () => {
    await handleRegisterFeature(
      repo,
      mockConfig,
      {
        feature_key: "cart-v2",
        domain: "orders",
        allowed_touchpoints: ["packages/orders/Cart.php"],
      },
      tempWorkspace1
    );

    const sessionFile = path.join(tempWorkspace1, ".septum", "session.json");
    expect(fs.existsSync(sessionFile)).toBe(true);

    const sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    expect(sessionData.feature_key).toBe("cart-v2");
    expect(sessionData.domain).toBe("orders");

    // Must NOT bleed into tempWorkspace2
    expect(fs.existsSync(path.join(tempWorkspace2, ".septum", "session.json"))).toBe(false);
  });

  it("handleRegisterFeature persists septum.config.json into the provided workspaceRoot", async () => {
    await handleRegisterFeature(
      repo,
      mockConfig,
      {
        feature_key: "checkout-step",
        domain: "orders",
        allowed_touchpoints: ["packages/orders/Checkout.php"],
        persist_to_config: true,
      },
      tempWorkspace2
    );

    const configFile = path.join(tempWorkspace2, "septum.config.json");
    expect(fs.existsSync(configFile)).toBe(true);

    const configData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(configData.features["checkout-step"]).toBeDefined();
    expect(configData.features["checkout-step"].domain).toBe("orders");
  });

  it("BoundaryEvaluator with ModuleResolver correctly resolves relative paths inside workspaceRoot", () => {
    const resolver = new ModuleResolver(tempWorkspace1, repo);
    const evaluator = new BoundaryEvaluator(repo, resolver);

    expect(evaluator.getResolver().getProjectRoot()).toBe(tempWorkspace1);

    const violations = evaluator.evaluate(
      "packages/orders/Service.php",
      ["packages/billing/PaymentService.php"],
      undefined,
      mockConfig
    );

    expect(Array.isArray(violations)).toBe(true);
  });

  it("handleCheckBoundary passes through without crashing when workspaceRoot is supplied", () => {
    const resolver = new ModuleResolver(tempWorkspace1, repo);
    const evaluator = new BoundaryEvaluator(repo, resolver);

    const result = handleCheckBoundary(
      evaluator,
      mockConfig,
      { file_path: "packages/orders/Service.php" },
      repo,
      tempWorkspace1
    );

    expect(result.content[0].type).toBe("text");
    const json = JSON.parse(result.content[0].text);
    expect(json.status).toBe("approved");
  });

  it("handleTraceVerticalSlice operates deterministically with custom workspaceRoot", () => {
    const result = handleTraceVerticalSlice(
      repo,
      mockConfig,
      { query: "GET /api/cart" },
      tempWorkspace2
    );

    const json = JSON.parse(result.content[0].text);
    expect(json.status).toBe("not_found");
    expect(json.found).toBe(false);
  });

  describe("extractPathHint Resolution", () => {
    it("extracts path hint from bare string file paths", () => {
      expect(extractPathHint("packages/orders/Service.php")).toBe("packages/orders/Service.php");
      expect(extractPathHint("  /path/to/project  ")).toBe("/path/to/project");
      expect(extractPathHint("")).toBeUndefined();
    });

    it("extracts path hint from bare string array", () => {
      expect(extractPathHint(["packages/orders/Service.php", "packages/orders/Model.php"])).toBe("packages/orders/Service.php");
      expect(extractPathHint([])).toBeUndefined();
    });

    it("extracts path hint from camelCase workspace and projectRoot properties", () => {
      expect(extractPathHint({ workspacePath: "/monorepo/subapp" })).toBe("/monorepo/subapp");
      expect(extractPathHint({ projectRoot: "/monorepo/billing" })).toBe("/monorepo/billing");
      expect(extractPathHint({ targetPath: "/monorepo/orders" })).toBe("/monorepo/orders");
    });

    it("extracts path hint from camelCase file properties", () => {
      expect(extractPathHint({ filePath: "packages/orders/Service.php" })).toBe("packages/orders/Service.php");
      expect(extractPathHint({ fromFile: "packages/billing/Pay.php" })).toBe("packages/billing/Pay.php");
      expect(extractPathHint({ filePaths: ["src/a.ts", "src/b.ts"] })).toBe("src/a.ts");
    });

    it("does not treat domain root from register_domain as workspace root", () => {
      expect(extractPathHint({ domain: "orders", root: "src/domains/orders" })).toBeUndefined();
      expect(extractPathHint({ name: "orders", root: "src/domains/orders" })).toBeUndefined();
    });

    it("extracts root as workspace root only when domain is not specified", () => {
      expect(extractPathHint({ root: "/path/to/workspace" })).toBe("/path/to/workspace");
    });
  });
});
