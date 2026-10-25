import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ElysiaSemanticExtractor } from "../../src/core/parser/extractors/elysia-semantic.ts";

describe("TS-Elysia — Elysia TypeBox Composition Extractor (L1-L5)", () => {
  let tmpDir: string;
  const extractor = new ElysiaSemanticExtractor();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-elysia-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts direct routes and TypeBox validation schema options", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { elysia: "^1.0.0" } })
    );
    expect(extractor.canHandle(tmpDir)).toBe(true);

    const appFile = path.join(tmpDir, "src/index.ts");
    fs.mkdirSync(path.dirname(appFile), { recursive: true });

    const code = `
import { Elysia, t } from "elysia";

const app = new Elysia();

app.get("/health", () => "ok");
app.post("/items", ({ body }) => body, {
  body: t.Object({
    name: t.String(),
    price: t.Number()
  })
});
`;
    fs.writeFileSync(appFile, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(2);

    const health = slices.find((s) => s.route_uri === "/health");
    expect(health).toBeDefined();
    expect(health?.http_method).toBe("GET");

    const item = slices.find((s) => s.route_uri === "/items");
    expect(item).toBeDefined();
    expect(item?.http_method).toBe("POST");

    const itemChain = JSON.parse(item!.execution_chain_json);
    expect(itemChain.some((c: any) => c.stage === "ingress" && c.symbol === "POST /items")).toBe(true);
    expect(itemChain.some((c: any) => c.stage === "validation")).toBe(true);
    expect(itemChain.some((c: any) => c.stage === "controller")).toBe(true);
  });

  it("resolves grouped routes with imported controllers, services, and persistence (L5)", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { elysia: "^1.0.0" } })
    );

    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(path.join(srcDir, "controllers"), { recursive: true });
    fs.mkdirSync(path.join(srcDir, "services"), { recursive: true });

    // 1. Service with Prisma
    fs.writeFileSync(
      path.join(srcDir, "services/product.service.ts"),
      `
import { prisma } from "../db";
export class ProductService {
  async findProducts() {
    return prisma.product.findMany();
  }
}
      `.trim()
    );

    // 2. Controller calling service
    fs.writeFileSync(
      path.join(srcDir, "controllers/product.controller.ts"),
      `
import { ProductService } from "../services/product.service";
const productService = new ProductService();

export const getProducts = async () => {
  return productService.findProducts();
};
      `.trim()
    );

    // 3. Main app with group prefix
    fs.writeFileSync(
      path.join(srcDir, "index.ts"),
      `
import { Elysia } from "elysia";
import { getProducts } from "./controllers/product.controller";

const app = new Elysia();
app.group("/api/v1", (api) =>
  api.get("/products", getProducts)
);
      `.trim()
    );

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(1);

    const productSlice = slices[0];
    expect(productSlice.route_uri).toBe("/api/v1/products");
    expect(productSlice.http_method).toBe("GET");
    expect(productSlice.controller_file).toBe("src/controllers/product.controller.ts");

    const chain = JSON.parse(productSlice.execution_chain_json);

    // L3: Controller link
    const ctrlNode = chain.find((c: any) => c.stage === "controller");
    expect(ctrlNode?.file).toBe("src/controllers/product.controller.ts");

    // L4: Service link
    const svcNode = chain.find((c: any) => c.stage === "service");
    expect(svcNode).toBeDefined();
    expect(svcNode?.symbol).toContain("productService::findProducts");
    expect(svcNode?.file).toBe("src/services/product.service.ts");

    // L5: Persistence link
    const repoNode = chain.find((c: any) => c.stage === "repository");
    expect(repoNode).toBeDefined();
    expect(repoNode?.symbol).toBe("ProductRepository");

    const entNode = chain.find((c: any) => c.stage === "entity");
    expect(entNode).toBeDefined();
    expect(entNode?.symbol).toBe("Product");
  });
});

