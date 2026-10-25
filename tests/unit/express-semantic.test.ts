import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExpressSemanticExtractor } from "../../src/core/parser/extractors/express-semantic.ts";

describe("TS-04 — Express Router Composition Extractor", () => {
  let tmpDir: string;
  const extractor = new ExpressSemanticExtractor();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-express-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts direct Express app routes with closures and middlewares", async () => {
    const appPath = path.join(tmpDir, "src/app.ts");
    fs.mkdirSync(path.dirname(appPath), { recursive: true });

    const code = `
import express from "express";
import { rateLimiter } from "./middleware/rate";
import { authHandler } from "./handlers/auth";

const app = express();

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.post("/login", rateLimiter, authHandler);
`;
    fs.writeFileSync(appPath, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(2);

    const health = slices.find((s) => s.route_uri === "/health");
    expect(health).toBeDefined();
    expect(health?.http_method).toBe("GET");
    const healthChain = JSON.parse(health!.execution_chain_json);
    expect(healthChain.some((c: any) => c.stage === "ingress" && c.symbol === "GET /health")).toBe(true);
    expect(healthChain.some((c: any) => c.stage === "controller")).toBe(true);

    const login = slices.find((s) => s.route_uri === "/login");
    expect(login).toBeDefined();
    expect(login?.http_method).toBe("POST");
    const loginChain = JSON.parse(login!.execution_chain_json);
    expect(loginChain.some((c: any) => c.stage === "middleware" && c.symbol === "rateLimiter")).toBe(true);
    expect(loginChain.some((c: any) => c.stage === "controller" && c.symbol === "authHandler")).toBe(true);
  });

  it("resolves mounted routers across multiple files with prefix composition", async () => {
    const appFile = path.join(tmpDir, "src/app.ts");
    const apiFile = path.join(tmpDir, "src/routes/api.ts");
    const userFile = path.join(tmpDir, "src/routes/users.ts");

    fs.mkdirSync(path.dirname(apiFile), { recursive: true });

    const appCode = `
import express from "express";
import apiRouter from "./routes/api";

const app = express();
app.use("/api/v1", apiRouter);
`;

    const apiCode = `
import express from "express";
import userRouter from "./users";

const router = express.Router();
router.use("/users", userRouter);

export default router;
`;

    const userCode = `
import { Router } from "express";
import { authCheck } from "../middleware/auth";
import { validateBody, sanitizeInput } from "../middleware/validation";
import * as userController from "../controllers/user";

const router = Router();

router.get("/", (req, res) => res.send("users"));
router.get("/:id", userController.getUser);
router.post("/", authCheck, [validateBody, sanitizeInput], userController.create);

export default router;
`;

    fs.writeFileSync(appFile, appCode);
    fs.writeFileSync(apiFile, apiCode);
    fs.writeFileSync(userFile, userCode);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(3);

    // 1. GET /api/v1/users
    const listSlice = slices.find((s) => s.http_method === "GET" && s.route_uri === "/api/v1/users");
    expect(listSlice).toBeDefined();
    expect(listSlice?.controller_file).toBe("src/routes/users.ts");

    // 2. GET /api/v1/users/:id
    const getSlice = slices.find((s) => s.http_method === "GET" && s.route_uri === "/api/v1/users/:id");
    expect(getSlice).toBeDefined();
    const getChain = JSON.parse(getSlice!.execution_chain_json);
    expect(getChain.some((c: any) => c.stage === "controller" && c.symbol === "userController.getUser")).toBe(true);

    // 3. POST /api/v1/users with middleware array
    const postSlice = slices.find((s) => s.http_method === "POST" && s.route_uri === "/api/v1/users");
    expect(postSlice).toBeDefined();
    const postChain = JSON.parse(postSlice!.execution_chain_json);
    expect(postChain.some((c: any) => c.stage === "middleware" && c.symbol === "authCheck")).toBe(true);
    expect(postChain.some((c: any) => c.stage === "middleware" && c.symbol === "validateBody")).toBe(true);
    expect(postChain.some((c: any) => c.stage === "middleware" && c.symbol === "sanitizeInput")).toBe(true);
    expect(postChain.some((c: any) => c.stage === "controller" && c.symbol === "userController.create")).toBe(true);
  });

  it("marks dynamic paths as partial/unresolved without inventing routes", async () => {
    const appFile = path.join(tmpDir, "src/server.ts");
    fs.mkdirSync(path.dirname(appFile), { recursive: true });

    const code = `
import express from "express";
const app = express();
const dynamicVerb = "get";
const dynamicPath = "/dynamic/" + Date.now();

app[dynamicVerb](dynamicPath, (req, res) => res.send("ok"));
app.get("/static", (req, res) => res.send("static"));
`;
    fs.writeFileSync(appFile, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(1);
    expect(slices[0].route_uri).toBe("/static");
  });

  it("resolves imported controller handler to its target controller file", async () => {
    const routeFile = path.join(tmpDir, "src/routes/order.routes.ts");
    const controllerFile = path.join(tmpDir, "src/controllers/order.controller.ts");
    fs.mkdirSync(path.dirname(routeFile), { recursive: true });
    fs.mkdirSync(path.dirname(controllerFile), { recursive: true });

    fs.writeFileSync(
      controllerFile,
      `export const placeOrder = (req: any, res: any) => res.json({ id: 1 });`
    );

    fs.writeFileSync(
      routeFile,
      `
import express from "express";
import { placeOrder } from "../controllers/order.controller";
const router = express.Router();
router.post("/orders", placeOrder);
export default router;
`
    );

    const slices = await extractor.extractSlices(tmpDir);
    const orderSlice = slices.find((s) => s.route_uri === "/orders");
    expect(orderSlice).toBeDefined();
    expect(orderSlice?.controller_file).toBe("src/controllers/order.controller.ts");

    const chain = JSON.parse(orderSlice!.execution_chain_json);
    const controllerNode = chain.find((c: any) => c.stage === "controller");
    expect(controllerNode?.file).toBe("src/controllers/order.controller.ts");
  });
});

