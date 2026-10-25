import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ElysiaSemanticExtractor } from "../../src/core/parser/extractors/elysia-semantic.ts";

describe("TS-Elysia — Elysia TypeBox Composition Extractor (L1-L5)", () => {
  let baseDir: string;
  let directAppDir: string;
  let groupedAppDir: string;
  const extractor = new ElysiaSemanticExtractor();

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-elysia-"));
    directAppDir = path.join(baseDir, "direct-app");
    groupedAppDir = path.join(baseDir, "grouped-app");

    // 1. Fixture for direct routes
    fs.mkdirSync(directAppDir, { recursive: true });
    fs.writeFileSync(
      path.join(directAppDir, "package.json"),
      JSON.stringify({ dependencies: { elysia: "^1.0.0" } })
    );
    const appFile = path.join(directAppDir, "src/index.ts");
    fs.mkdirSync(path.dirname(appFile), { recursive: true });
    fs.writeFileSync(
      appFile,
      `
import { Elysia, t } from "elysia";

const app = new Elysia();

app.get("/health", () => "ok");
app.post("/items", ({ body }) => body, {
  body: t.Object({
    name: t.String(),
    price: t.Number()
  })
});
`
    );

    // 2. Fixture for grouped routes with imported controllers, services, and persistence
    fs.mkdirSync(groupedAppDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupedAppDir, "package.json"),
      JSON.stringify({ dependencies: { elysia: "^1.0.0" } })
    );
    const srcDir = path.join(groupedAppDir, "src");
    fs.mkdirSync(path.join(srcDir, "controllers"), { recursive: true });
    fs.mkdirSync(path.join(srcDir, "services"), { recursive: true });

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
  });

  afterAll(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("extracts direct routes and TypeBox validation schema options", async () => {
    expect(extractor.canHandle(directAppDir)).toBe(true);

    const slices = await extractor.extractSlices(directAppDir);
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
    const slices = await extractor.extractSlices(groupedAppDir);
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

