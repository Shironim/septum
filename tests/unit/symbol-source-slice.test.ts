import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { computeContentHash } from "../../src/core/ingestion/hasher.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { SymbolToolSchema } from "../../src/mcp/schemas.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";

describe("backend symbol source slices", () => {
  let root: string;
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let source: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "septum-source-slice-"));
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    const domainId = repo.upsertDomain("orders", { root: "src/orders" });
    source = ["export function updateOrder() {", "  validateOrder();", "  saveOrder();", "}", ""].join("\n");
    writeFileSync(join(root, "service.ts"), source);
    const fileId = repo.upsertFile(domainId, "service.ts", "service", computeContentHash(source), 5);
    repo.replaceFileSymbols(fileId, [{
      name: "updateOrder",
      kind: "function",
      signature: "updateOrder()",
      visibility: "public",
      line_start: 1,
      line_end: 4,
      line_count: 4,
    }]);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a bounded, file-qualified source request", () => {
    const args = SymbolToolSchema.parse({
      action: "inspect",
      query: "updateOrder",
      file_path: "service.ts",
      include_source: true,
      source_line_limit: 2,
    });
    expect(args.file_path).toBe("service.ts");
    expect(args.include_source).toBe(true);
    expect(args.source_line_limit).toBe(2);
    expect(SymbolToolSchema.parse({ action: "inspect", query: "updateOrder", filePath: "service.ts" }).file_path)
      .toBe("service.ts");
    expect(() => SymbolToolSchema.parse({ action: "inspect", query: "updateOrder", source_line_limit: 201 }))
      .toThrow();
  });

  it("returns only the requested current source lines and a continuation cursor", async () => {
    const config = ConfigLoader.load(undefined, root);
    const result = await handleSymbolTool(repo, config, {
      action: "inspect",
      query: "updateOrder",
      file_path: "service.ts",
      include_source: true,
      source_line_limit: 2,
    }, undefined, root);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.source_slice.status).toBe("current");
    expect(payload.source_slice.start_line).toBe(1);
    expect(payload.source_slice.end_line).toBe(2);
    expect(payload.source_slice.text).toBe("export function updateOrder() {\n  validateOrder();");
    expect(payload.source_slice.truncated).toBe(true);
    expect(payload.source_slice.next_start_line).toBe(3);
  });

  it("does not present source at stale indexed coordinates as the selected symbol", async () => {
    writeFileSync(join(root, "service.ts"), "export function renamedOrder() {}\n");
    const config = ConfigLoader.load(undefined, root);
    const result = await handleSymbolTool(repo, config, {
      action: "inspect",
      query: "updateOrder",
      file_path: "service.ts",
      include_source: true,
    }, undefined, root);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.source_slice.status).toBe("stale");
    expect(payload.source_slice.text).toBeUndefined();
    expect(payload.source_slice.current_content_hash).not.toBe(payload.source_slice.indexed_content_hash);
  });

  it("requires a file selection when a source symbol has multiple indexed candidates", async () => {
    const domainId = repo.upsertDomain("payments", { root: "src/payments" });
    const fileId = repo.upsertFile(domainId, "payment-service.ts", "service", computeContentHash(source), 5);
    repo.replaceFileSymbols(fileId, [{
      name: "updateOrder",
      kind: "function",
      signature: "updateOrder()",
      visibility: "public",
      line_start: 1,
      line_end: 4,
      line_count: 4,
    }]);
    const config = ConfigLoader.load(undefined, root);
    const result = await handleSymbolTool(repo, config, {
      action: "inspect",
      query: "updateOrder",
      include_source: true,
    }, undefined, root);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.source_slice.status).toBe("ambiguous");
    expect(payload.source_slice.candidates).toHaveLength(2);
    expect(payload.source_slice.candidates.map((candidate: { file_path: string }) => candidate.file_path)).toContain("service.ts");
    expect(payload.source_slice.candidates.map((candidate: { file_path: string }) => candidate.file_path)).toContain("payment-service.ts");
  });

  it("refuses an indexed path that escapes the workspace", async () => {
    const domainId = repo.upsertDomain("outside", { root: ".." });
    const fileId = repo.upsertFile(domainId, "../outside.ts", "service", computeContentHash(source), 5);
    repo.replaceFileSymbols(fileId, [{
      name: "updateOrder",
      kind: "function",
      signature: "updateOrder()",
      visibility: "public",
      line_start: 1,
      line_end: 4,
      line_count: 4,
    }]);
    const config = ConfigLoader.load(undefined, root);
    const result = await handleSymbolTool(repo, config, {
      action: "inspect",
      query: "updateOrder",
      file_path: "../outside.ts",
      include_source: true,
    }, undefined, root);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.source_slice.status).toBe("out_of_scope");
    expect(payload.source_slice.text).toBeUndefined();
  });

  it("labels a missing symbol when source was requested", async () => {
    const config = ConfigLoader.load(undefined, root);
    const result = await handleSymbolTool(repo, config, {
      action: "inspect",
      query: "missingOrder",
      include_source: true,
    }, undefined, root);
    const payload = JSON.parse(result.content[0].text);

    expect(payload.found).toBe(false);
    expect(payload.source_slice.status).toBe("unavailable");
    expect(payload.source_slice.reason).toBe("symbol_not_found");
  });
});
