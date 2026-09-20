import { describe, expect, test } from "bun:test";
import { LaravelSemanticExtractor } from "../src/core/parser/extractors/laravel-semantic.ts";
import { VerticalSliceTracer } from "../src/core/resolver/vertical-slice-tracer.ts";
import type { VerticalSliceRecord } from "../src/types/index.ts";

describe("LaravelSemanticExtractor Route Parser", () => {
  const extractor = new LaravelSemanticExtractor("/tmp/mock-project");

  test("parses Route::post with controller array and route name", () => {
    const routeContent = `
      <?php
      use Illuminate\\Support\\Facades\\Route;
      use App\\Http\\Controllers\\OrderController;

      Route::post('/orders/{id}/status', [OrderController::class, 'updateStatus'])->name('orders.update_status');
    `;

    const parsed = extractor.parseRoutesContent(routeContent);
    expect(parsed.length).toBe(1);
    expect(parsed[0].httpMethod).toBe("post");
    expect(parsed[0].uri).toBe("/orders/{id}/status");
    expect(parsed[0].controllerClass).toBe("OrderController");
    expect(parsed[0].actionName).toBe("updateStatus");
    expect(parsed[0].routeName).toBe("orders.update_status");
  });

  test("parses Route::resource and expands RESTful actions", () => {
    const routeContent = `
      Route::resource('orders', OrderController::class);
    `;

    const parsed = extractor.parseRoutesContent(routeContent);
    expect(parsed.length).toBe(7);
    const showRoute = parsed.find((r) => r.actionName === "show");
    expect(showRoute).toBeDefined();
    expect(showRoute?.uri).toBe("/orders/{id}");
    expect(showRoute?.httpMethod).toBe("GET");
  });
});

describe("VerticalSliceTracer End-to-End Tracing", () => {
  const mockChain = [
    {
      stage: "ingress",
      symbol: "POST /orders/{id}/status",
      file: "routes/web.php",
      description: "HTTP Ingress: orders.update_status",
    },
    {
      stage: "validation",
      symbol: "UpdateOrderStatusRequest",
      file: "app/Http/Requests/UpdateOrderStatusRequest.php",
      description: "Form Request Validation",
    },
    {
      stage: "controller",
      symbol: "OrderController::updateStatus",
      file: "app/Http/Controllers/OrderController.php",
      line: 42,
      description: "Controller Action",
    },
    {
      stage: "entity",
      symbol: "Order",
      file: "app/Models/Order.php",
      description: "Eloquent Model",
    },
    {
      stage: "egress",
      symbol: "resources/js/Pages/Orders/Show.vue",
      description: "Frontend View Target",
    },
  ];

  const mockSlice: VerticalSliceRecord = {
    id: 1,
    domain_id: 1,
    feature_key: "orders.update_status",
    http_method: "POST",
    route_uri: "/orders/{id}/status",
    route_name: "orders.update_status",
    controller_class: "OrderController",
    action_name: "updateStatus",
    controller_file: "app/Http/Controllers/OrderController.php",
    controller_line: 42,
    architecture_style: "mvc",
    entry_kind: "http_route",
    execution_chain_json: JSON.stringify(mockChain),
    created_at: "2026-09-18T00:00:00Z",
  };

  const mockRepo: any = {
    getAllVerticalSlices: () => [mockSlice],
  };

  const tracer = new VerticalSliceTracer(mockRepo);

  test("resolves vertical slice via exact HTTP method and URI", () => {
    const res = tracer.trace("POST /orders/{id}/status");
    expect(res.found).toBe(true);
    expect(res.entrypoint?.method).toBe("POST");
    expect(res.entrypoint?.uri).toBe("/orders/{id}/status");
    expect(res.chain?.length).toBe(5);
    expect(res.chain?.some((c) => c.stage === "validation" && c.symbol === "UpdateOrderStatusRequest")).toBe(true);
    expect(res.chain?.some((c) => c.stage === "controller" && c.symbol === "OrderController::updateStatus")).toBe(true);
    expect(res.chain?.some((c) => c.stage === "entity" && c.symbol === "Order")).toBe(true);
    expect(res.message).toContain("=== VERTICAL SLICE TRACE");
  });

  test("resolves vertical slice via Controller@action syntax", () => {
    const res = tracer.trace("OrderController@updateStatus");
    expect(res.found).toBe(true);
    expect(res.entrypoint?.uri).toBe("/orders/{id}/status");
  });

  test("resolves vertical slice via route name", () => {
    const res = tracer.trace("orders.update_status");
    expect(res.found).toBe(true);
    expect(res.entrypoint?.action).toBe("updateStatus");
  });

  test("resolves vertical slice via exact symbol name", () => {
    const res = tracer.trace("updateStatus");
    expect(res.found).toBe(true);
    expect(res.entrypoint?.controller).toBe("OrderController");
  });

  test("resolves vertical slice via natural language intent ('Ubah status order di dashboard')", () => {
    const res = tracer.trace("Ubah status order di dashboard");
    expect(res.found).toBe(true);
    expect(res.entrypoint?.method).toBe("POST");
    expect(res.entrypoint?.uri).toBe("/orders/{id}/status");
  });
});
