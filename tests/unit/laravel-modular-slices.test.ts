import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LaravelSemanticExtractor } from "../../src/core/parser/extractors/laravel-semantic.ts";
import type { ExecutionChainNode } from "../../src/types/index.ts";

describe("Laravel Modular Slices & API Resources (PHP-03)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-laravel-modular-"));

    // Set up composer.json with custom modular PSR-4 mapping
    fs.writeFileSync(
      path.join(tempDir, "composer.json"),
      JSON.stringify({
        autoload: {
          "psr-4": {
            "App\\": "app/",
            "Modules\\": "modules/",
          },
        },
      }),
      "utf-8"
    );

    // Create directories
    fs.mkdirSync(path.join(tempDir, "routes"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "modules/Billing/Controllers"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "app/Http/Controllers"), { recursive: true });

    // 1. routes/api.php
    fs.writeFileSync(
      path.join(tempDir, "routes/api.php"),
      `<?php
use Illuminate\\Support\\Facades\\Route;
use Modules\\Billing\\Controllers\\InvoiceController;
use App\\Http\\Controllers\\WebhookController;

Route::prefix('v1')->group(function () {
    Route::apiResource('invoices', InvoiceController::class);
    Route::post('/webhook', WebhookController::class);
    Route::get('/health', function () {
        return response()->json(['status' => 'ok']);
    });
});
`,
      "utf-8"
    );

    // 2. Modular InvoiceController outside app/Http/Controllers
    fs.writeFileSync(
      path.join(tempDir, "modules/Billing/Controllers/InvoiceController.php"),
      `<?php
namespace Modules\\Billing\\Controllers;

class InvoiceController
{
    public function index() {}
    public function store() {}
    public function show($id) {}
    public function update($id) {}
    public function destroy($id) {}
}
`,
      "utf-8"
    );

    // 3. Invokable WebhookController
    fs.writeFileSync(
      path.join(tempDir, "app/Http/Controllers/WebhookController.php"),
      `<?php
namespace App\\Http\\Controllers;

class WebhookController
{
    public function __invoke()
    {
        return response()->noContent();
    }
}
`,
      "utf-8"
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("Happy Path", () => {
    it("resolves modular controller outside app/ via ImportResolver and expands apiResource", () => {
      const extractor = new LaravelSemanticExtractor(tempDir);
      const slices = extractor.extractSlices(tempDir);

      // apiResource should generate 5 RESTful actions (index, store, show, update, destroy)
      const invoiceSlices = slices.filter((s) => s.route_uri.includes("/invoices"));
      expect(invoiceSlices.length).toBe(5);

      const storeSlice = invoiceSlices.find((s) => s.http_method === "POST");
      expect(storeSlice).toBeDefined();
      expect(storeSlice?.controller_class).toBe("InvoiceController");
      expect(storeSlice?.action_name).toBe("store");
      // Must resolve to the modular location via PSR-4
      expect(storeSlice?.controller_file).toBe("modules/Billing/Controllers/InvoiceController.php");

      const chain: ExecutionChainNode[] = JSON.parse(storeSlice!.execution_chain_json);
      const controllerNode = chain.find((n) => n.stage === "controller");
      expect(controllerNode).toBeDefined();
      expect(controllerNode?.file).toBe("modules/Billing/Controllers/InvoiceController.php");
    });
  });

  describe("Edge Cases", () => {
    it("resolves invokable controller mapped with ::class to __invoke", () => {
      const extractor = new LaravelSemanticExtractor(tempDir);
      const slices = extractor.extractSlices(tempDir);

      const webhookSlice = slices.find((s) => s.route_uri === "/v1/webhook" && s.http_method === "POST");
      expect(webhookSlice).toBeDefined();
      expect(webhookSlice?.action_name).toBe("__invoke");
      expect(webhookSlice?.controller_file).toBe("app/Http/Controllers/WebhookController.php");
    });

    it("extracts closure route with Closure controllerClass and distinct URI", () => {
      const extractor = new LaravelSemanticExtractor(tempDir);
      const slices = extractor.extractSlices(tempDir);

      const healthSlice = slices.find((s) => s.route_uri === "/v1/health" && s.http_method === "GET");
      expect(healthSlice).toBeDefined();
      expect(healthSlice?.controller_class).toBe("Closure");
      expect(healthSlice?.action_name).toBe("handle");
    });
  });

  describe("Unhappy Path", () => {
    it("handles route to missing controller gracefully without crashing", () => {
      fs.writeFileSync(
        path.join(tempDir, "routes/web.php"),
        `<?php
Route::get('/missing', [NonExistentController::class, 'someAction']);
`,
        "utf-8"
      );

      const extractor = new LaravelSemanticExtractor(tempDir);
      const slices = extractor.extractSlices(tempDir);

      const missingSlice = slices.find((s) => s.route_uri === "/missing");
      expect(missingSlice).toBeDefined();
      expect(missingSlice?.controller_file).toBeNull();
      expect(missingSlice?.controller_line).toBe(0);
    });
  });
});

