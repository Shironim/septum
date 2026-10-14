import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/check-boundary.ts";
import { CheckBoundarySchema } from "../../src/mcp/schemas.ts";

describe("boundary scope contract", () => {
  let root: string;
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let evaluator: BoundaryEvaluator;
  let config: ReturnType<typeof ConfigLoader.getDefaultConfig>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "septum-boundary-scope-"));
    mkdirSync(join(root, "src/orders"), { recursive: true });
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "src/orders/Order.ts"), "import { invoice } from '../billing/Invoice';\nexport const total = invoice();\n");
    writeFileSync(join(root, "src/orders/Other.ts"), "export const other = 1;\n");
    writeFileSync(join(root, "src/billing/Invoice.ts"), "export function invoice() { return 1; }\n");
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    config = ConfigLoader.getDefaultConfig();
    config.domains = {
      orders: { root: "src/orders", allowed_dependencies: [], forbidden_dependencies: ["billing"], archetypes: {} },
      billing: { root: "src/billing", allowed_dependencies: [], forbidden_dependencies: [], archetypes: {} },
    };
    await new IngestionPipeline(repo, root).run(config);
    evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
  });

  afterEach(() => {
    db?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const invalidInputs: Array<[string, Record<string, unknown>]> = [
    ...["all", "staged", "domain"].flatMap(scope => [
      [`${scope} with file_path`, { scope, domain: scope === "domain" ? "orders" : undefined, file_path: "src/orders/Order.ts" }],
      [`${scope} with file_paths`, { scope, domain: scope === "domain" ? "orders" : undefined, file_paths: ["src/orders/Order.ts"] }],
    ] as Array<[string, Record<string, unknown>]>),
    ["file without target", { scope: "file" }],
    ["file with empty targets", { scope: "file", file_paths: [] }],
    ["blank file_path", { file_path: "   " }],
    ["blank batch target", { file_paths: ["src/orders/Order.ts", " "] }],
    ["domain without domain name", { scope: "domain" }],
    ["file scope without target even with domain", { scope: "file", domain: "orders" }],
    ["staged flag with file target", { staged: true, file_path: "src/orders/Order.ts" }],
    ["staged flag conflicting with all", { staged: true, scope: "all" }],
    ["all with domain filter", { scope: "all", domain: "orders" }],
    ["two competing target fields", { file_path: "src/orders/Order.ts", file_paths: ["src/orders/Other.ts"] }],
    ["proposed imports without target", { proposed_imports: ["../billing/Invoice"] }],
    ["staged with proposed imports", { scope: "staged", proposed_imports: ["../billing/Invoice"] }],
  ];

  for (const [name, args] of invalidInputs) {
    it(`rejects ${name} instead of checking a different scope`, async () => {
      await expect(handleCheckBoundary(evaluator, config, args as any, repo, root)).rejects.toThrow();
    });
  }

  for (const args of [
    { scope: "domain", domain: "missing" },
    { scope: "staged", domain: "missing" },
    { file_path: "src/orders/Order.ts", domain: "missing" },
  ]) {
    it(`does not approve unknown domain for ${args.scope ?? "file"} scope`, async () => {
      await expect(handleCheckBoundary(evaluator, config, args as any, repo, root)).rejects.toThrow(/domain/i);
    });
  }

  it("keeps a default whole-repository audit", async () => {
    const result = await handleCheckBoundary(evaluator, config, {}, repo, root);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.scope).toBe("all");
    expect(payload.status).toBe("rejected");
    expect(payload.violations[0].rule).toBe("forbidden_dependency");
  });

  it("keeps an implicit file preflight and its proposed imports", async () => {
    const result = await handleCheckBoundary(evaluator, config, {
      file_path: "src/orders/Other.ts", proposed_imports: ["../billing/Invoice"],
    }, repo, root);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.file).toBe("src/orders/Other.ts");
    expect(payload.status).toBe("rejected");
    expect(payload.violations[0].rule).toBe("forbidden_dependency");
  });

  it("keeps batch file preflight", async () => {
    const result = await handleCheckBoundary(evaluator, config, {
      scope: "file", file_paths: ["src/orders/Order.ts", "src/orders/Other.ts"],
      proposed_imports: ["../billing/Invoice"],
    }, repo, root);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("rejected");
    expect(payload.total_checked).toBe(2);
    expect(payload.results.every((entry: any) => entry.status === "rejected")).toBe(true);
  });

  it("keeps implicit domain audit and canonicalizes domain case", async () => {
    const result = await handleCheckBoundary(evaluator, config, { domain: "ORDERS" }, repo, root);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.scope).toBe("domain");
    expect(payload.domain).toBe("orders");
    expect(payload.status).toBe("rejected");
  });

  it("preserves staged scope with a domain filter and audits Git blobs", async () => {
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "add", "src"], { cwd: root }).exitCode).toBe(0);
    writeFileSync(join(root, "src/orders/Order.ts"), "export const total = 1;\n");
    await new IngestionPipeline(repo, root).run(config);
    const result = await handleCheckBoundary(evaluator, config, { scope: "staged", domain: "orders" }, repo, root);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.scope).toBe("staged");
    expect(payload.status).toBe("rejected");
    expect(payload.violations[0].rule).toBe("forbidden_dependency");
  });

  it("supports the legacy staged boolean with a domain filter", () => {
    const args = CheckBoundarySchema.parse({ staged: true, domain: "orders" });
    expect(args.scope).toBe("staged");
  });

  it("keeps bare-string and file-path aliases", () => {
    expect(CheckBoundarySchema.parse("src/orders/Order.ts").file_path).toBe("src/orders/Order.ts");
    expect(CheckBoundarySchema.parse({ filePath: "src/orders/Order.ts" }).file_path).toBe("src/orders/Order.ts");
  });

  it("does not hide unsupported files when a domain filter uses different case", async () => {
    repo.setMeta("unsupported_files", '["src/orders/unsupported.rs"]');
    const result = await handleCheckBoundary(evaluator, config, { domain: "ORDERS" }, repo, root);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.status).toBe("unknown");
    expect(payload.unsupported_files).toEqual(["src/orders/unsupported.rs"]);
  });
});
