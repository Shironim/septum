import { describe, expect, it } from "bun:test";
import { BehavioralAnalyzer } from "../../src/core/parser/behavioral-analyzer.ts";
import { LaravelSemanticExtractor } from "../../src/core/parser/extractors/laravel-semantic.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("BehavioralAnalyzer - Side-Effect & Semantic Digest", () => {
  it("should extract guards, transactions, events, jobs, and mutations from method body", () => {
    const actionCode = `
      public function checkout(OrderRequest $request) {
        $this->authorize('create', Order::class);

        return DB::transaction(function() use ($request) {
          $order = Order::create($request->validated());
          $order->status = 'processing';
          $order->update(['notes' => 'urgent']);

          ProcessPaymentJob::dispatch($order);
          event(new OrderPlaced($order));

          return response()->json($order);
        });
      }
    `;

    const summary = BehavioralAnalyzer.analyzeMethod(actionCode);
    expect(summary.guards).toContain("create");
    expect(summary.hasTransaction).toBe(true);
    expect(summary.dispatchedJobs).toContain("ProcessPaymentJob");
    expect(summary.emittedEvents).toContain("OrderPlaced");
    expect(summary.mutations).toContain("order.status");
    expect(summary.mutations).toContain("order.update()");
  });
});

describe("Omni-Trigger Vertical Slices - Jobs, Commands, and Listeners", () => {
  it("should extract Queue Job, Console Command, and Event Listener slices", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-omni-test-"));
    const jobsDir = path.join(tmpDir, "app", "Jobs");
    const commandsDir = path.join(tmpDir, "app", "Console", "Commands");
    const listenersDir = path.join(tmpDir, "app", "Listeners");
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(listenersDir, { recursive: true });

    // 1. Create a Queue Job
    const jobContent = `<?php
namespace App\\Jobs;
class ProcessPaymentJob {
  public function handle() {
    DB::transaction(function() {
      event(new PaymentCompleted());
    });
  }
}
`;
    fs.writeFileSync(path.join(jobsDir, "ProcessPaymentJob.php"), jobContent);

    // 2. Create a Console Command
    const commandContent = `<?php
namespace App\\Console\\Commands;
class CleanupOrdersCommand {
  protected $signature = 'orders:cleanup';
  public function handle() {
    ProcessPaymentJob::dispatch();
  }
}
`;
    fs.writeFileSync(path.join(commandsDir, "CleanupOrdersCommand.php"), commandContent);

    // 3. Create an Event Listener
    const listenerContent = `<?php
namespace App\\Listeners;
class SendOrderInvoiceListener {
  public function handle(OrderPlaced $event) {
    // send email
  }
}
`;
    fs.writeFileSync(path.join(listenersDir, "SendOrderInvoiceListener.php"), listenerContent);

    const extractor = new LaravelSemanticExtractor(tmpDir);
    const result = extractor.extractSlices(tmpDir);
    const slices = result.slices;

    // Check Job Slice
    const jobSlice = slices.find((s) => s.http_method === "JOB");
    expect(jobSlice).toBeDefined();
    expect(jobSlice?.controller_class).toBe("ProcessPaymentJob");
    expect(jobSlice?.entry_kind).toBe("queue_job");

    const jobChain = JSON.parse(jobSlice!.execution_chain_json);
    expect(jobChain.some((n: any) => n.stage === "transaction")).toBe(true);
    expect(jobChain.some((n: any) => n.stage === "event" && n.symbol === "PaymentCompleted")).toBe(true);

    // Check Command Slice
    const cmdSlice = slices.find((s) => s.http_method === "CLI");
    expect(cmdSlice).toBeDefined();
    expect(cmdSlice?.route_uri).toBe("command:orders:cleanup");
    expect(cmdSlice?.entry_kind).toBe("scheduled_command");

    const cmdChain = JSON.parse(cmdSlice!.execution_chain_json);
    expect(cmdChain.some((n: any) => n.stage === "job" && n.symbol === "ProcessPaymentJob")).toBe(true);

    // Check Listener Slice
    const listenerSlice = slices.find((s) => s.http_method === "EVENT");
    expect(listenerSlice).toBeDefined();
    expect(listenerSlice?.route_uri).toBe("event:SendOrderInvoiceListener");
    expect(listenerSlice?.entry_kind).toBe("event_listener");

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should trace Omni-Trigger queries through VerticalSliceTracer", () => {
    const tmpDbPath = path.join(os.tmpdir(), `septum-tracer-test-${Date.now()}.db`);
    const db = new SeptumDatabase(tmpDbPath);
    const repo = new SeptumRepository(db.raw);

    // Seed a Job slice
    repo.upsertVerticalSlice({
      domain_id: null,
      feature_key: "job:ProcessPaymentJob",
      http_method: "JOB",
      route_uri: "job:ProcessPaymentJob",
      route_name: "queue.process_payment_job",
      controller_class: "ProcessPaymentJob",
      action_name: "handle",
      controller_file: "app/Jobs/ProcessPaymentJob.php",
      controller_line: 10,
      architecture_style: "clean",
      entry_kind: "queue_job",
      execution_chain_json: JSON.stringify([
        { stage: "ingress", symbol: "JOB ProcessPaymentJob" },
        { stage: "controller", symbol: "ProcessPaymentJob::handle", mutations: ["order.status"] },
        { stage: "event", symbol: "PaymentCompleted", emits: ["PaymentCompleted"] },
      ]),
    });

    const tracer = new VerticalSliceTracer(repo, os.tmpdir());

    // Test exact query: "JOB ProcessPaymentJob"
    const traceJob = tracer.trace("JOB ProcessPaymentJob");
    expect(traceJob.found).toBe(true);
    expect(traceJob.entrypoint?.controller).toBe("ProcessPaymentJob");
    expect(traceJob.message).toContain("[INGRESS]");
    expect(traceJob.message).toContain("JOB ProcessPaymentJob");
    expect(traceJob.message).toContain("[CONTROLLER]");
    expect(traceJob.message).toContain("ProcessPaymentJob::handle [mutates: order.status]");
    expect(traceJob.message).toContain("[EVENT]");
    expect(traceJob.message).toContain("PaymentCompleted");

    // Test natural language query
    const traceNL = tracer.trace("ProcessPaymentJob");
    expect(traceNL.found).toBe(true);
    expect(traceNL.entrypoint?.controller).toBe("ProcessPaymentJob");

    // Clean up
    db.close();
    try {
      fs.unlinkSync(tmpDbPath);
      fs.unlinkSync(`${tmpDbPath}-wal`);
      fs.unlinkSync(`${tmpDbPath}-shm`);
    } catch {}
  });
});
