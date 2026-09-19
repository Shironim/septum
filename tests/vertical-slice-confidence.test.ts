import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { VerticalSliceTracer } from "../src/core/resolver/vertical-slice-tracer.ts";
import { SeptumDatabase } from "../src/core/database/client.ts";
import { SeptumRepository } from "../src/core/database/repository.ts";

describe("VerticalSliceTracer Deterministic Confidence & Resilience", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let tracer: VerticalSliceTracer;

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    tracer = new VerticalSliceTracer(repo);
  });

  afterEach(() => {
    db.close();
  });

  it("handles empty catalog without crashing", () => {
    const result = tracer.trace("GET /api/unknown");
    expect(result.found).toBe(false);
    expect(result.message).toContain("No vertical slices cataloged");
  });

  it("returns confidence 'exact' for exact route matches", () => {
    repo.upsertVerticalSlice({
      domain_id: null,
      feature_key: null,
      http_method: "POST",
      route_uri: "/api/orders",
      route_name: "orders.store",
      controller_class: "OrderController",
      action_name: "store",
      controller_file: "app/Http/Controllers/OrderController.php",
      controller_line: 25,
      architecture_style: "mvc",
      entry_kind: "http_route",
      execution_chain_json: JSON.stringify([
        { stage: "route", symbol: "POST /api/orders", file: "routes/api.php", line: 12 },
        { stage: "controller", symbol: "OrderController@store", file: "app/Http/Controllers/OrderController.php", line: 25 }
      ]),
    });

    const result = tracer.trace("POST /api/orders");
    expect(result.found).toBe(true);
    expect(result.confidence).toBe("exact");
    expect(result.is_exact_match).toBe(true);
    expect(result.entrypoint?.controller).toBe("OrderController");
  });

  it("returns confidence 'inferred' for natural language / semantic token queries", () => {
    repo.upsertVerticalSlice({
      domain_id: null,
      feature_key: null,
      http_method: "POST",
      route_uri: "/api/orders",
      route_name: "orders.store",
      controller_class: "OrderController",
      action_name: "store",
      controller_file: "app/Http/Controllers/OrderController.php",
      controller_line: 25,
      architecture_style: "mvc",
      entry_kind: "http_route",
      execution_chain_json: JSON.stringify([]),
    });

    const result = tracer.trace("create new order payload");
    expect(result.found).toBe(true);
    expect(result.confidence).toBe("inferred");
    expect(result.is_exact_match).toBe(false);
  });
});
