import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { SessionManager } from "../../src/core/session/session-manager.ts";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { handleCheckBoundary } from "../../src/mcp/tools/check-boundary.ts";
import { handleRegisterFeature } from "../../src/mcp/tools/register-feature.ts";
import { TABLE_STATEMENTS } from "../../src/core/database/schema.ts";
import { GoExtractor } from "../../src/core/parser/extractors/go.ts";
import { GetSymbolImpactSchema } from "../../src/mcp/schemas.ts";
import { McpCliSemanticExtractor } from "../../src/core/parser/extractors/mcp-cli-semantic.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";
import { VerticalSliceTracer } from "../../src/core/resolver/vertical-slice-tracer.ts";

describe("MCP follow-up fixes", () => {
  let root: string;
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "septum-followup-"));
    db = new SeptumDatabase(join(root, ".septum/septum.db"));
    repo = new SeptumRepository(db.raw);
    repo.upsertDomain("orders", { root: "src/orders" });
    repo.setMeta("sync_state", "complete");
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("preserves a successful owner update across a rejected second process", () => {
    const probe = Bun.spawnSync(["bun", resolve(import.meta.dir, "../integration/feature-lock-race.ts")]);
    expect(probe.stderr.toString()).toBe("");
    expect(probe.exitCode).toBe(0);
  });

  it("serializes two simultaneous owners so only one feature and lease is accepted", async () => {
    const script = resolve(import.meta.dir, "../integration/feature-lock-race.ts");
    const owners = ["contender-a", "contender-b"];
    const children = owners.map(owner => Bun.spawn(["bun", script, "contend", root, owner], { stdout: "pipe", stderr: "pipe" }));
    try {
      const deadline = Date.now() + 3000;
      while (!owners.every(owner => fs.existsSync(join(root, `.ready-${owner}`)))) {
        expect(Date.now()).toBeLessThan(deadline);
        await Bun.sleep(10);
      }
      fs.writeFileSync(join(root, ".start"), "start");
      const responses = await Promise.all(children.map(async child => {
        const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(errors).toBe("");
        expect(exit).toBe(0);
        return JSON.parse(output);
      }));
      const winners = responses.filter(r => r.accepted);
      expect(winners).toHaveLength(1);
      expect(Object.keys(JSON.parse(repo.getMeta("features_json")!))).toEqual([winners[0].owner]);
      expect(SessionManager.getActiveSession(root)?.owner_id).toBe(winners[0].owner);
    } finally { for (const child of children) { child.kill(); await child.exited; } }
  });

  it("rejects a different owner before touching persisted metadata", async () => {
    const config = ConfigLoader.loadFromRepository(repo);
    SessionManager.saveActiveSession(root, { feature_key: "owned", domain: "orders", touchpoints: [] }, "other-owner");
    db.raw.run("CREATE TRIGGER no_feature_write BEFORE INSERT ON repo_meta WHEN NEW.key='features_json' BEGIN SELECT RAISE(ABORT,'unexpected metadata mutation'); END");
    await expect(handleRegisterFeature(repo, config, { feature_key: "contender", domain: "orders" }, root)).rejects.toThrow(/owned by/);
    expect(repo.getMeta("features_json")).toBeNull();
    expect(SessionManager.getActiveSession(root)?.feature_key).toBe("owned");
  });

  it("rolls back SQLite and preserves the old lease when atomic rename fails", async () => {
    const config = ConfigLoader.loadFromRepository(repo);
    await handleRegisterFeature(repo, config, { feature_key: "old", domain: "orders" }, root);
    const before = repo.getMeta("features_json");
    const lease = fs.readFileSync(join(root, ".septum/session.json"), "utf8");
    const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("injected rename failure"); });
    try {
      await expect(handleRegisterFeature(repo, config, { feature_key: "new", domain: "orders" }, root)).rejects.toThrow("injected rename failure");
    } finally { rename.mockRestore(); }
    expect(repo.getMeta("features_json")).toBe(before);
    expect(fs.readFileSync(join(root, ".septum/session.json"), "utf8")).toBe(lease);
    expect(config.features.new).toBeUndefined();
  });

  for (const content of ["{broken", "{}", '{"feature_key":"f","domain":"orders","touchpoints":[null]}']) {
    it(`rejects an untrusted session in the boundary handler: ${content}`, async () => {
      fs.writeFileSync(join(root, ".septum/session.json"), content);
      const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
      await expect(handleCheckBoundary(evaluator, ConfigLoader.loadFromRepository(repo), { file_path: "src/orders/a.ts" }, repo, root)).rejects.toThrow(/session/i);
      expect(SessionManager.clearActiveSession(root, undefined, true)).toBe(true);
    });
  }

  function legacyDomains(forbidden = "[]") {
    db.raw.run("PRAGMA foreign_keys=OFF; DROP TABLE domains;");
    db.raw.run(TABLE_STATEMENTS[0].replace(" COLLATE NOCASE", ""));
    db.raw.run("PRAGMA foreign_keys=ON;");
    db.raw.query("INSERT INTO domains(name,root_path,forbidden_deps_json) VALUES ('orders','src/orders','[]'),('Orders','src/orders',?)").run(forbidden);
    const second = repo.getAllDomains().find(d => d.name === "Orders")!;
    const file = repo.upsertFile(second.id, "src/orders/a.ts", "service", "h", 1);
    repo.replaceFileSymbols(file, [{ name: "A", kind: "class", signature: "class A", visibility: "public", line_start: 1, line_end: 1, line_count: 1 }]);
    repo.replaceFileDependencies(file, [{ target: "Other", statement: "import Other", line_number: 1, is_external: false }]);
    db.raw.query("INSERT INTO vertical_slices(domain_id,http_method,route_uri,controller_class,action_name,execution_chain_json) VALUES (?,'GET','/a','A','get','[]')").run(second.id);
    return { second, file };
  }

  it("consolidates equal legacy domains without losing files, symbols, dependencies or slices", () => {
    const { file } = legacyDomains();
    const canonical = repo.upsertDomain("Orders", { root: "src/orders" });
    expect(repo.getAllDomains()).toHaveLength(1);
    expect(repo.getFileByPath("src/orders/a.ts")?.domain_id).toBe(canonical);
    expect(repo.getSymbolsByFileId(file)).toHaveLength(1);
    expect(repo.getAllDependenciesWithDomains()).toHaveLength(1);
    expect(repo.getAllVerticalSlices()).toHaveLength(1);
    expect(repo.getAllVerticalSlices()[0].domain_id).toBe(canonical);
  });

  it("rejects conflicting legacy rules without modifying any row; explicit rules resolve it", () => {
    const { second } = legacyDomains('["billing"]');
    expect(() => repo.upsertDomain("Orders", { root: "src/orders" })).toThrow(/conflict.*forbidden_dependencies/i);
    expect(repo.getAllDomains()).toHaveLength(2);
    expect(repo.getFileByPath("src/orders/a.ts")?.domain_id).toBe(second.id);
    expect(repo.getAllVerticalSlices()).toHaveLength(1);
    const id = repo.upsertDomain("Orders", { root: "src/orders", forbidden_dependencies: ["billing"] });
    expect(JSON.parse(repo.getDomainByName("orders")!.forbidden_deps_json)).toEqual(["billing"]);
    expect(repo.getAllVerticalSlices()[0].domain_id).toBe(id);
  });

  it("rolls back every FK move if duplicate deletion fails", () => {
    const { second } = legacyDomains();
    db.raw.run("CREATE TRIGGER reject_domain_delete BEFORE DELETE ON domains BEGIN SELECT RAISE(ABORT,'injected delete failure'); END");
    expect(() => repo.upsertDomain("Orders", { root: "src/orders" })).toThrow("injected delete failure");
    expect(repo.getFileByPath("src/orders/a.ts")?.domain_id).toBe(second.id);
    expect(repo.getAllVerticalSlices()[0].domain_id).toBe(second.id);
    expect(repo.getAllDomains()).toHaveLength(2);
  });

  it("resolves Go receiver identity instead of any bare method with the same name", async () => {
    const ast = await new GoExtractor().extract("src/orders/other.go", "package orders\ntype Other struct {}\nfunc (o *Other) Submit() {}\n");
    const id = repo.upsertFile(repo.getDomainByName("orders")!.id, "src/orders/other.go", "service", "h", 3);
    repo.replaceFileSymbols(id, ast.symbols);
    const missing = repo.getSymbolImpact("MissingController::Submit");
    expect(missing.found_in_index).toBe(false);
    expect(missing.impact_summary.risk_level).toBe("unknown");
    expect(repo.getSymbolImpact("Other::Submit").found_in_index).toBe(true);
  });

  it("preserves impact domain in the shared schema", () => {
    expect(GetSymbolImpactSchema.parse({ symbol: "Other", domain: "orders" }).domain).toBe("orders");
  });

  it("returns the declared connection summary when dependencies are disabled", () => {
    const id = repo.upsertFile(repo.getDomainByName("orders")!.id, "src/orders/a.ts", "service", "h", 1);
    repo.replaceFileSymbols(id, [{ name: "A", kind: "class", signature: "class A", visibility: "public", line_start: 1, line_end: 1, line_count: 1 }]);
    expect(repo.getSymbolDetails("A", { includeDependencies: false })?.connected_files).toEqual({ imports_from: [], imported_by_count: 0 });
  });

  it("emits exactly five public MCP ingress entries with the dispatched boundary wrapper", () => {
    const entries = new McpCliSemanticExtractor().extractSlices(resolve(import.meta.dir, "../..")).filter(s => s.http_method === "MCP");
    expect(entries).toHaveLength(5);
    expect(new Set(entries.map(s => s.route_name)).size).toBe(5);
    expect(entries.find(s => s.route_name === "septum_boundary")?.controller_file).toBe("src/mcp/tools/boundary.ts");
  });

  it("reads nested public tool schemas and ignores nested names, strings and comments", () => {
    fs.mkdirSync(join(root, "src/mcp/tools"), { recursive: true });
    fs.writeFileSync(join(root, "package.json"), '{"name":"demo"}');
    fs.writeFileSync(join(root, "src/mcp/server.ts"), `
      import { ListToolsRequestSchema } from 'sdk';
      // name: 'demo_internal', tools: [
      const decoy = "tools: [ { name: 'demo_internal' } ]";
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: 'demo_domain', inputSchema: { required: ['action'], properties: { name: 'demo_internal' } } },
        { name: 'demo_symbol', description: 'brackets ] } and name: demo_internal' }
      ] }));
    `);
    for (const name of ["domain", "symbol", "internal"]) fs.writeFileSync(join(root, `src/mcp/tools/${name}.ts`), `export function handle_${name}() {}`);
    const names = new McpCliSemanticExtractor().extractSlices(root).filter(s => s.http_method === "MCP").map(s => s.route_name);
    expect(names.sort()).toEqual(["demo_domain", "demo_symbol"]);
  });

  it("invalidates legacy semantic slices once even when project files did not change", async () => {
    fs.mkdirSync(join(root, "src/orders"), { recursive: true });
    fs.writeFileSync(join(root, "package.json"), '{"name":"cache-fixture"}');
    fs.writeFileSync(join(root, "src/orders/a.ts"), "export function a() {}");
    const features = JSON.stringify({ retained: { domain: "orders", allowed_touchpoints: ["src/orders/a.ts"], reuse_symbols: [], input_contract: {}, output_contract: {} } });
    repo.setMeta("features_json", features);
    const config = ConfigLoader.loadFromRepository(repo);
    const pipeline = new IngestionPipeline(repo, root);
    await pipeline.run(config, { verifyContent: true });
    repo.upsertVerticalSlice({ domain_id: null, feature_key: null, http_method: "MCP", route_uri: "tool:septum_get_symbol", route_name: "septum_get_symbol", controller_class: "get-symbol", action_name: "handleGetSymbol", controller_file: null, controller_line: 1, execution_chain_json: "[]" });
    repo.setMeta("semantic_extractor_revision", "");
    const result = await pipeline.run(config, { verifyContent: true });
    expect(result.files_updated).toBe(0);
    expect(new VerticalSliceTracer(repo, root).trace("septum_get_symbol").found).toBe(false);
    expect(repo.getDomainByName("orders")).not.toBeNull();
    expect(repo.getMeta("features_json")).toBe(features);
    const revision = repo.getMeta("semantic_extractor_revision");
    expect(revision).toBeTruthy();
    const again = await pipeline.run(config, { verifyContent: true });
    expect(again.files_updated).toBe(0);
    expect(repo.getMeta("semantic_extractor_revision")).toBe(revision);
  });
});
