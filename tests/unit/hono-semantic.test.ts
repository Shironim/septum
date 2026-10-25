import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HonoSemanticExtractor } from "../../src/core/parser/extractors/hono-semantic.ts";

describe("TS-Hono — Hono Router & Middleware Extractor (L1-L5)", () => {
  let tmpDir: string;
  const extractor = new HonoSemanticExtractor();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-hono-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts direct routes and zValidator validation schemas", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { hono: "^4.0.0", "@hono/zod-validator": "^0.2.0" } })
    );
    expect(extractor.canHandle(tmpDir)).toBe(true);

    const appFile = path.join(tmpDir, "src/index.ts");
    fs.mkdirSync(path.dirname(appFile), { recursive: true });

    const code = `
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createOrderSchema } from "./schemas/order";

const app = new Hono();

app.get("/health", (c) => c.text("ok"));
app.post("/orders", zValidator("json", createOrderSchema), (c) => c.json({ status: "created" }));
`;
    fs.writeFileSync(appFile, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(2);

    const health = slices.find((s) => s.route_uri === "/health");
    expect(health).toBeDefined();
    expect(health?.http_method).toBe("GET");

    const order = slices.find((s) => s.route_uri === "/orders");
    expect(order).toBeDefined();
    expect(order?.http_method).toBe("POST");

    const orderChain = JSON.parse(order!.execution_chain_json);
    expect(orderChain.some((c: any) => c.stage === "ingress" && c.symbol === "POST /orders")).toBe(true);
    expect(orderChain.some((c: any) => c.stage === "validation" && c.symbol === "createOrderSchema")).toBe(true);
    expect(orderChain.some((c: any) => c.stage === "controller")).toBe(true);
  });

  it("resolves mounted sub-routers with prefix composition and penetrates to service & persistence (L5)", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { hono: "^4.0.0" } })
    );

    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(path.join(srcDir, "controllers"), { recursive: true });
    fs.mkdirSync(path.join(srcDir, "services"), { recursive: true });
    fs.mkdirSync(path.join(srcDir, "routes"), { recursive: true });

    // 1. Service with Prisma call
    fs.writeFileSync(
      path.join(srcDir, "services/user.service.ts"),
      `
import { prisma } from "../db";
export class UserService {
  async getAllUsers() {
    return prisma.user.findMany();
  }
}
      `.trim()
    );

    // 2. Controller calling UserService
    fs.writeFileSync(
      path.join(srcDir, "controllers/user.controller.ts"),
      `
import { UserService } from "../services/user.service";
const userService = new UserService();

export const listUsers = async (c: any) => {
  const users = await userService.getAllUsers();
  return c.json(users);
};
      `.trim()
    );

    // 3. User sub-routes
    fs.writeFileSync(
      path.join(srcDir, "routes/users.ts"),
      `
import { Hono } from "hono";
import { listUsers } from "../controllers/user.controller";

const userRoutes = new Hono();
userRoutes.get("/", listUsers);

export default userRoutes;
      `.trim()
    );

    // 4. Main app mounting sub-router
    fs.writeFileSync(
      path.join(srcDir, "index.ts"),
      `
import { Hono } from "hono";
import userRoutes from "./routes/users";

const app = new Hono();
app.route("/api/v1/users", userRoutes);
      `.trim()
    );

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(1);

    const userSlice = slices[0];
    expect(userSlice.route_uri).toBe("/api/v1/users/");
    expect(userSlice.http_method).toBe("GET");
    expect(userSlice.controller_file).toBe("src/controllers/user.controller.ts");
    expect(userSlice.action_name).toBe("listUsers");

    const chain = JSON.parse(userSlice.execution_chain_json);

    // L3: Controller link
    const ctrlNode = chain.find((c: any) => c.stage === "controller");
    expect(ctrlNode?.file).toBe("src/controllers/user.controller.ts");

    // L4: Service link
    const svcNode = chain.find((c: any) => c.stage === "service");
    expect(svcNode).toBeDefined();
    expect(svcNode?.symbol).toContain("userService::getAllUsers");
    expect(svcNode?.file).toBe("src/services/user.service.ts");

    // L5: Persistence link
    const repoNode = chain.find((c: any) => c.stage === "repository");
    expect(repoNode).toBeDefined();
    expect(repoNode?.symbol).toBe("UserRepository");

    const entNode = chain.find((c: any) => c.stage === "entity");
    expect(entNode).toBeDefined();
    expect(entNode?.symbol).toBe("User");
  });
});

