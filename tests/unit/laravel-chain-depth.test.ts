import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LaravelSemanticExtractor } from "../../src/core/parser/extractors/laravel-semantic.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import type { ExecutionChainNode } from "../../src/types/index.ts";

describe("Laravel Execution Chain Depth (Action/Service & Inertia Props)", () => {
  let tempDir: string;
  let db: SeptumDatabase;
  let repo: SeptumRepository;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-laravel-chain-"));
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);

    // Create directory structure
    fs.mkdirSync(path.join(tempDir, "routes"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "app/Http/Controllers"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "app/Http/Requests"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "app/Actions"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "app/Services"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "app/Models"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "resources/js/Pages/Penjualan"), { recursive: true });

    // 1. routes/web.php
    fs.writeFileSync(
      path.join(tempDir, "routes/web.php"),
      `<?php
use Illuminate\\Support\\Facades\\Route;
use App\\Http\\Controllers\\PenjualanController;

Route::post('/penjualan', [PenjualanController::class, 'store'])->name('penjualan.store');
Route::get('/penjualan', [PenjualanController::class, 'index'])->name('penjualan.index');
`,
      "utf-8"
    );

    // 2. Controller with DI Action, Service call, FormRequest, Model, and Inertia render
    fs.writeFileSync(
      path.join(tempDir, "app/Http/Controllers/PenjualanController.php"),
      `<?php
namespace App\\Http\\Controllers;

use App\\Http\\Requests\\StorePenjualanRequest;
use App\\Actions\\RecordPembayaranAction;
use App\\Services\\PenjualanService;
use App\\Models\\Penjualan;
use Inertia\\Inertia;

class PenjualanController extends Controller
{
    public function __construct(
        protected PenjualanService $penjualanService
    ) {}

    public function store(StorePenjualanRequest $request, RecordPembayaranAction $action)
    {
        $penjualan = Penjualan::create($request->validated());
        $action->execute($penjualan);
        $this->penjualanService->processNotification($penjualan);

        return Inertia::render('Penjualan/Index', [
            'penjualan' => $penjualan,
            'filters' => $request->all(),
            'stats' => ['total' => 100],
        ]);
    }

    public function index()
    {
        return Inertia::render('Penjualan/Index', [
            'items' => [],
        ]);
    }
}
`,
      "utf-8"
    );

    // 3. FormRequest
    fs.writeFileSync(
      path.join(tempDir, "app/Http/Requests/StorePenjualanRequest.php"),
      `<?php
namespace App\\Http\\Requests;

class StorePenjualanRequest
{
    public function rules() {
        return ['nominal' => 'required|numeric'];
    }
}
`,
      "utf-8"
    );

    // 4. Action
    fs.writeFileSync(
      path.join(tempDir, "app/Actions/RecordPembayaranAction.php"),
      `<?php
namespace App\\Actions;

class RecordPembayaranAction
{
    public function execute($penjualan) {}
}
`,
      "utf-8"
    );

    // 5. Service
    fs.writeFileSync(
      path.join(tempDir, "app/Services/PenjualanService.php"),
      `<?php
namespace App\\Services;

class PenjualanService
{
    public function processNotification($penjualan) {}
}
`,
      "utf-8"
    );

    // 6. Model
    fs.writeFileSync(
      path.join(tempDir, "app/Models/Penjualan.php"),
      `<?php
namespace App\\Models;

class Penjualan
{
    protected $fillable = ['nominal', 'customer_id'];
}
`,
      "utf-8"
    );

    // 7. Vue Page
    fs.writeFileSync(
      path.join(tempDir, "resources/js/Pages/Penjualan/Index.vue"),
      `<template><div>Penjualan</div></template>`,
      "utf-8"
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should extract full execution chain with [ACTION], [SERVICE], and Inertia props", () => {
    const extractor = new LaravelSemanticExtractor(tempDir);
    expect(extractor.canHandle(tempDir, "laravel")).toBe(true);

    const slices = extractor.extractSlices(tempDir);
    expect(slices.length).toBeGreaterThanOrEqual(2);

    const storeSlice = slices.find((s) => s.http_method === "POST" && s.route_uri === "/penjualan");
    expect(storeSlice).toBeDefined();

    const chain: ExecutionChainNode[] = JSON.parse(storeSlice!.execution_chain_json);
    const stages = chain.map((n) => n.stage);

    // Must detect: ingress -> validation -> controller -> action & service -> entity -> egress
    expect(stages).toContain("ingress");
    expect(stages).toContain("validation");
    expect(stages).toContain("controller");
    expect(stages).toContain("action");
    expect(stages).toContain("service");
    expect(stages).toContain("entity");
    expect(stages).toContain("egress");

    // Action node verification
    const actionNode = chain.find((n) => n.stage === "action");
    expect(actionNode?.symbol).toBe("RecordPembayaranAction");
    expect(actionNode?.file).toBe("app/Actions/RecordPembayaranAction.php");

    // Service node verification
    const serviceNode = chain.find((n) => n.stage === "service");
    expect(serviceNode?.symbol).toBe("PenjualanService");
    expect(serviceNode?.file).toBe("app/Services/PenjualanService.php");

    // Inertia egress node verification with payload_props
    const egressNode = chain.find((n) => n.stage === "egress");
    expect(egressNode?.symbol).toBe("resources/js/Pages/Penjualan/Index.vue");
    expect(egressNode?.payload_props).toContain("penjualan");
    expect(egressNode?.payload_props).toContain("filters");
    expect(egressNode?.payload_props).toContain("stats");
  });

  it("should trace vertical slice end-to-end and provide slice compatibility alias", () => {
    const extractor = new LaravelSemanticExtractor(tempDir);
    const slices = extractor.extractSlices(tempDir);
    for (const s of slices) {
      repo.upsertVerticalSlice(s);
    }

    const tracer = new VerticalSliceTracer(repo, tempDir);
    const res = tracer.trace("POST /penjualan");

    expect(res.found).toBe(true);
    expect(res.chain).toBeDefined();
    // Verify backward compatibility alias 'slice'
    expect(res.slice).toBeDefined();
    expect(res.slice).toEqual(res.chain!);

    // Ensure action and service appear in formatted message
    expect(res.message).toContain("[ACTION]");
    expect(res.message).toContain("RecordPembayaranAction");
    expect(res.message).toContain("[SERVICE]");
    expect(res.message).toContain("PenjualanService");
  });
});
