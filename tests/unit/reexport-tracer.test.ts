import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { CallGraphTracer } from "../../src/core/resolver/call-graph-tracer.ts";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";
import { computeContentHash } from "../../src/core/ingestion/hasher.ts";

describe("TS-02d — Multi-Hop Re-export Symbol Resolution in CallGraphTracer", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let tmpDir: string;

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-reexport-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("traces symbol through re-exporting barrel files to original declaration", async () => {
    const parser = new ASTParserEngine();

    // 1. Files layout
    const controllerPath = "src/controllers/order.controller.ts";
    const barrelPath = "src/services/index.ts";
    const actualServicePath = "src/services/order.service.ts";

    const controllerCode = `
import { OrderService } from "../services";
export class OrderController {
  constructor(private readonly svc: OrderService) {}
}
`;
    const barrelCode = `
export { OrderService } from "./order.service";
`;
    const actualServiceCode = `
export class OrderService {
  public cancelOrder(id: string): boolean {
    return true;
  }
}
`;

    fs.mkdirSync(path.join(tmpDir, "src/controllers"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src/services"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, controllerPath), controllerCode);
    fs.writeFileSync(path.join(tmpDir, barrelPath), barrelCode);
    fs.writeFileSync(path.join(tmpDir, actualServicePath), actualServiceCode);

    // 2. Index domain & files
    const domainId = repo.upsertDomain("core", { root: "." });

    const cAst = await parser.parseFile(controllerPath, controllerCode);
    const cId = repo.upsertFile(domainId, controllerPath, "controller", computeContentHash(controllerCode), 10);
    repo.replaceFileSymbols(cId, cAst.symbols);
    repo.replaceFileDependencies(cId, cAst.dependencies);

    const bAst = await parser.parseFile(barrelPath, barrelCode);
    const bId = repo.upsertFile(domainId, barrelPath, "service", computeContentHash(barrelCode), 5);
    repo.replaceFileSymbols(bId, bAst.symbols);
    repo.replaceFileDependencies(bId, bAst.dependencies);

    const sAst = await parser.parseFile(actualServicePath, actualServiceCode);
    const sId = repo.upsertFile(domainId, actualServicePath, "service", computeContentHash(actualServiceCode), 10);
    repo.replaceFileSymbols(sId, sAst.symbols);
    repo.replaceFileDependencies(sId, sAst.dependencies);

    // 3. Initialize tracer
    const tracer = new CallGraphTracer(repo, tmpDir);
    tracer.initMaps();

    // Use internal symbol resolver through barrel
    // @ts-expect-error private method test
    const found = tracer.findFileBySymbolOrName("OrderService", controllerPath);

    expect(found).not.toBeNull();
    expect(found?.file.path).toBe(actualServicePath);
    expect(found?.symbol?.name).toBe("OrderService");
    expect(found?.symbol?.kind).toBe("class");
  });
});

