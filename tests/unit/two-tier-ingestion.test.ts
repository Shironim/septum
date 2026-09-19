import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";

describe("Two-Tier Ingestion & Reconciliation Pipeline", () => {
  const testDir = join(import.meta.dir, "../fixtures/two_tier_test");
  const dbPath = join(testDir, "test.db");
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let pipeline: IngestionPipeline;

  const mockConfig: ValidatedSeptumConfig = {
    version: "1.0",
    settings: {
      enforcement: "strict",
      db_path: dbPath,
      ignore_patterns: ["**/node_modules/**"],
    },
    domains: {
      billing: {
        root: join(testDir, "billing"),
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {
          services: "service",
        },
      },
    },
  };

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, "billing/services"), { recursive: true });

    db = new SeptumDatabase(dbPath);
    repo = new SeptumRepository(db.raw);
    pipeline = new IngestionPipeline(repo);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("performs initial full ingestion and populates mtime and size metadata", async () => {
    const fileA = join(testDir, "billing/services/InvoiceService.ts");
    writeFileSync(
      fileA,
      `export class InvoiceService {
        calculateTotal(): number { return 100; }
      }`
    );

    const metrics = await pipeline.run(mockConfig);
    expect(metrics.files_scanned).toBe(1);
    expect(metrics.files_updated).toBe(1);
    expect(metrics.files_skipped).toBe(0);
    expect(metrics.symbols_indexed).toBeGreaterThan(0);

    const record = repo.getFileByPath("billing/services/InvoiceService.ts");
    expect(record).not.toBeNull();
    expect(record?.mtime_ms).toBeGreaterThan(0);
    expect(record?.size_bytes).toBeGreaterThan(0);
  });

  it("Tier 1 Fast Check skips re-reading and re-parsing untouched files", async () => {
    const fileA = join(testDir, "billing/services/InvoiceService.ts");
    writeFileSync(fileA, "export class InvoiceService {}");

    // Pass 1: Ingest
    const metrics1 = await pipeline.run(mockConfig);
    expect(metrics1.files_updated).toBe(1);
    expect(metrics1.files_skipped).toBe(0);

    // Pass 2: Ingest without touching file
    const metrics2 = await pipeline.run(mockConfig);
    expect(metrics2.files_scanned).toBe(1);
    expect(metrics2.files_skipped).toBe(1);
    expect(metrics2.files_updated).toBe(0);
  });

  it("Tier 2 Content Hash Check detects mtime change without content change", async () => {
    const fileA = join(testDir, "billing/services/InvoiceService.ts");
    writeFileSync(fileA, "export class InvoiceService {}");

    await pipeline.run(mockConfig);

    // Update mtime without altering content (touch)
    const futureTime = new Date(Date.now() + 5000);
    utimesSync(fileA, futureTime, futureTime);

    const metrics = await pipeline.run(mockConfig);
    expect(metrics.files_scanned).toBe(1);
    expect(metrics.files_skipped).toBe(1);
    expect(metrics.files_updated).toBe(0);
  });

  it("reconciles deleted files and prunes orphaned records from database", async () => {
    const fileA = join(testDir, "billing/services/InvoiceService.ts");
    const fileB = join(testDir, "billing/services/TaxService.ts");
    writeFileSync(fileA, "export class InvoiceService {}");
    writeFileSync(fileB, "export class TaxService {}");

    await pipeline.run(mockConfig);
    expect(repo.getFileByPath("billing/services/InvoiceService.ts")).not.toBeNull();
    expect(repo.getFileByPath("billing/services/TaxService.ts")).not.toBeNull();

    // Delete fileB from disk
    rmSync(fileB);

    await pipeline.run(mockConfig);

    expect(repo.getFileByPath("billing/services/InvoiceService.ts")).not.toBeNull();
    expect(repo.getFileByPath("billing/services/TaxService.ts")).toBeNull();
  });
});
