import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HonoSemanticExtractor } from "../../src/core/parser/extractors/hono-semantic.ts";

describe("TS-Hono — Hono Router & Middleware Extractor (L1-L5)", () => {
  let baseDir: string;
  let directAppDir: string;
  let mountedAppDir: string;
  const extractor = new HonoSemanticExtractor();

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-hono-"));
    directAppDir = path.join(baseDir, "direct-app");
    mountedAppDir = path.join(baseDir, "mounted-app");

    // 1. Fixture for direct routes
    fs.mkdirSync(directAppDir, { recursive: true });
    fs.writeFileSync(
      path.join(directAppDir, "package.json"),
      JSON.stringify({ dependencies: { hono: "^4.0.0", "@hono/zod-validator": "^0.2.0" } })
    );
    const directAppFile = path.join(directAppDir, "src/index.ts");
    fs.mkdirSync(path.dirname(directAppFile), { recursive: true });
    fs.writeFileSync(
      directAppFile,
      `
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createOrderSchema } from "./schemas/order";

const app = new Hono();

app.get("/health", (c) => c.text("ok"));
app.post("/orders", zValidator("json", createOrderSchema), (c) => c.json({ status: "created" }));
`
    );

    // 2. Fixture for mounted sub-routers with penetration to service & persistence
    fs.mkdirSync(mountedAppDir, { recursive: true });
    fs.writeFileSync(
      path.join(mountedAppDir, "package.json"),
      JSON.stringify({ dependencies: { hono: "^4.0.0" } })
    );
    const mountedSrcDir = path.join(mountedAppDir, "src");
    fs.mkdirSync(path.join(mountedSrcDir, "controllers"), { recursive: true });
    fs.mkdirSync(path.join(mountedSrcDir, "services"), { recursive: true });
    fs.mkdirSync(path.join(mountedSrcDir, "routes"), { recursive: true });

    fs.writeFileSync(
      path.join(mountedSrcDir, "services/user.service.ts"),
      `
import { prisma } from "../db";
export class UserService {
  async getAllUsers() {
    return prisma.user.findMany();
  }
}
      `.trim()
    );

    fs.writeFileSync(
      path.join(mountedSrcDir, "controllers/user.controller.ts"),
      `
import { UserService } from "../services/user.service";
const userService = new UserService();

export const listUsers = async (c: any) => {
  const users = await userService.getAllUsers();
  return c.json(users);
};
      `.trim()
    );

    fs.writeFileSync(
      path.join(mountedSrcDir, "routes/users.ts"),
      `
import { Hono } from "hono";
import { listUsers } from "../controllers/user.controller";

const userRoutes = new Hono();
userRoutes.get("/", listUsers);

export default userRoutes;
      `.trim()
    );

    fs.writeFileSync(
      path.join(mountedSrcDir, "index.ts"),
      `
import { Hono } from "hono";
import userRoutes from "./routes/users";

const app = new Hono();
app.route("/api/v1/users", userRoutes);
      `.trim()
    );
  });

  afterAll(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("extracts direct routes and zValidator validation schemas", async () => {
    expect(extractor.canHandle(directAppDir)).toBe(true);

    const slices = await extractor.extractSlices(directAppDir);
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
    const slices = await extractor.extractSlices(mountedAppDir);
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

