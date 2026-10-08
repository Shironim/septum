import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { handleTraceVerticalSlice } from "../../src/mcp/tools/trace-vertical-slice.ts";

describe("Vertical Slice Output Standardization (JSON Contracts)", () => {
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

  it("returns parseable JSON string in content[0].text when slice is not found", () => {
    const result = handleTraceVerticalSlice(repo, mockConfig, {
      query: "POST /unregistered/order",
    });

    expect(result.content[0].type).toBe("text");
    const json = JSON.parse(result.content[0].text);

    expect(json.status).toBe("not_found");
    expect(json.found).toBe(false);
    expect(json.query).toBe("POST /unregistered/order");
    expect(json.summary).toBe("[NOT FOUND] No vertical slice matching 'POST /unregistered/order'");
    expect(json.chain).toEqual([]);
    expect(json.alternatives).toEqual([]);
  });

  it("returns parseable structured JSON with comprehensive metadata when slice is found", () => {
    repo.upsertVerticalSlice({
      domain_id: null,
      feature_key: null,
      http_method: "POST",
      route_uri: "/orders/{id}/status",
      route_name: "orders.updateStatus",
      controller_class: "OrderController",
      action_name: "updateStatus",
      controller_file: "app/Http/Controllers/OrderController.php",
      controller_line: 42,
      architecture_style: "mvc",
      entry_kind: "http_route",
      execution_chain_json: JSON.stringify([
        { stage: "ingress", symbol: "POST /orders/{id}/status", file: "routes/api.php", line: 10 },
        { stage: "controller", symbol: "OrderController@updateStatus", file: "app/Http/Controllers/OrderController.php", line: 42 },
        { stage: "egress", symbol: "resources/js/Pages/Orders/Show.vue", file: "resources/js/Pages/Orders/Show.vue" },
      ]),
    });

    const result = handleTraceVerticalSlice(repo, mockConfig, {
      query: "POST /orders/{id}/status",
    });

    const json = JSON.parse(result.content[0].text);

    expect(json.status).toBe("success");
    expect(json.found).toBe(true);
    expect(json.query).toBe("POST /orders/{id}/status");
    expect(json.chain.length).toBe(3);
    expect(json.chain[0].stage).toBe("ingress");
    expect(json.chain[1].symbol).toBe("OrderController@updateStatus");
    expect(json.summary).toBe(
      "[INGRESS] POST /orders/{id}/status ➔ [CONTROLLER] OrderController@updateStatus ➔ [EGRESS] resources/js/Pages/Orders/Show.vue"
    );
  });

  it("accepts custom workspaceRoot parameter gracefully", () => {
    const result = handleTraceVerticalSlice(
      repo,
      mockConfig,
      { query: "GET /health" },
      "/custom/workspace/root"
    );

    const json = JSON.parse(result.content[0].text);
    expect(json.status).toBe("not_found");
    expect(json.query).toBe("GET /health");
  });

  it("rejects empty query by throwing actionable error", () => {
    expect(() =>
      handleTraceVerticalSlice(repo, mockConfig, { query: "" })
    ).toThrow("Missing required argument: 'query'");
  });
});

