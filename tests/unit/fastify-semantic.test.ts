import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FastifySemanticExtractor } from "../../src/core/parser/extractors/fastify-semantic.ts";

describe("TS-05 — Fastify Plugin Scoping Extractor", () => {
  let baseDir: string;
  let tmpDir: string;
  let extractor: FastifySemanticExtractor;

  beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-fastify-"));
    extractor = new FastifySemanticExtractor();
  });

  afterAll(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(baseDir, "test-"));
  });

  it("extracts shorthand routes with hooks and TypeScript body DTO", async () => {
    const appPath = path.join(tmpDir, "src/app.ts");
    fs.mkdirSync(path.dirname(appPath), { recursive: true });

    const code = `
import Fastify from "fastify";
import { authPreHandler } from "./hooks/auth";
import { userHandler, healthHandler } from "./handlers/users";

interface CreateUserDto {
  name: string;
  email: string;
}

const fastify = Fastify();

fastify.get("/health", healthHandler);
fastify.post<{ Body: CreateUserDto }>("/users", { preHandler: authPreHandler }, userHandler);
`;
    fs.writeFileSync(appPath, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(2);

    const health = slices.find((s) => s.route_uri === "/health");
    expect(health).toBeDefined();
    expect(health?.http_method).toBe("GET");
    const healthChain = JSON.parse(health!.execution_chain_json);
    expect(healthChain.some((c: any) => c.stage === "ingress" && c.symbol === "GET /health")).toBe(true);
    expect(healthChain.some((c: any) => c.stage === "controller" && c.symbol === "healthHandler")).toBe(true);

    const user = slices.find((s) => s.route_uri === "/users");
    expect(user).toBeDefined();
    expect(user?.http_method).toBe("POST");
    const userChain = JSON.parse(user!.execution_chain_json);
    expect(userChain.some((c: any) => c.stage === "middleware" && c.symbol === "authPreHandler")).toBe(true);
    expect(userChain.some((c: any) => c.stage === "validation" && c.symbol === "CreateUserDto")).toBe(true);
    expect(userChain.some((c: any) => c.stage === "controller" && c.symbol === "userHandler")).toBe(true);
  });

  it("extracts route options object syntax and multi-method routes", async () => {
    const appPath = path.join(tmpDir, "src/app.ts");
    fs.mkdirSync(path.dirname(appPath), { recursive: true });

    const code = `
import Fastify from "fastify";
import { handleStatus, handleReport } from "./handlers";

const fastify = Fastify();

fastify.route({
  method: "GET",
  url: "/status",
  handler: handleStatus
});

fastify.route({
  method: ["GET", "POST"],
  url: "/reports",
  handler: handleReport
});
`;
    fs.writeFileSync(appPath, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(3);

    const status = slices.find((s) => s.route_uri === "/status" && s.http_method === "GET");
    expect(status).toBeDefined();

    const reportGet = slices.find((s) => s.route_uri === "/reports" && s.http_method === "GET");
    expect(reportGet).toBeDefined();

    const reportPost = slices.find((s) => s.route_uri === "/reports" && s.http_method === "POST");
    expect(reportPost).toBeDefined();
  });

  it("strictly enforces plugin encapsulation without leaking prefixes across sibling plugins", async () => {
    const appPath = path.join(tmpDir, "src/server.ts");
    fs.mkdirSync(path.dirname(appPath), { recursive: true });

    const code = `
import Fastify, { FastifyInstance } from "fastify";

const server = Fastify();

async function userRoutes(fastify: FastifyInstance) {
  fastify.get("/list", (req, reply) => reply.send([]));
  fastify.post("/create", (req, reply) => reply.send({}));
}

async function itemRoutes(fastify: FastifyInstance) {
  fastify.get("/list", (req, reply) => reply.send([]));
  fastify.get("/detail/:id", (req, reply) => reply.send({}));
}

server.register(userRoutes, { prefix: "/users" });
server.register(itemRoutes, { prefix: "/items" });
`;
    fs.writeFileSync(appPath, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(4);

    const userList = slices.find((s) => s.route_uri === "/users/list");
    const userCreate = slices.find((s) => s.route_uri === "/users/create");
    const itemList = slices.find((s) => s.route_uri === "/items/list");
    const itemDetail = slices.find((s) => s.route_uri === "/items/detail/:id");

    expect(userList).toBeDefined();
    expect(userCreate).toBeDefined();
    expect(itemList).toBeDefined();
    expect(itemDetail).toBeDefined();

    // Sibling encapsulation proof: user routes must NOT have /items, item routes must NOT have /users
    expect(slices.some((s) => s.route_uri === "/users/items/list")).toBe(false);
    expect(slices.some((s) => s.route_uri === "/items/users/list")).toBe(false);
  });

  it("resolves multi-tier nested plugin hierarchies across files", async () => {
    const appFile = path.join(tmpDir, "src/app.ts");
    const apiFile = path.join(tmpDir, "src/routes/api.ts");
    const authFile = path.join(tmpDir, "src/routes/auth.ts");

    fs.mkdirSync(path.dirname(apiFile), { recursive: true });

    const appCode = `
import Fastify from "fastify";
import apiPlugin from "./routes/api";

const app = Fastify();
app.register(apiPlugin, { prefix: "/api/v1" });
`;

    const apiCode = `
import { FastifyInstance } from "fastify";
import authPlugin from "./auth";

export default async function (fastify: FastifyInstance) {
  fastify.get("/ping", async () => ({ ping: "pong" }));
  fastify.register(authPlugin, { prefix: "/auth" });
}
`;

    const authCode = `
import { FastifyInstance } from "fastify";

export default async function (fastify: FastifyInstance) {
  fastify.post("/login", async (req, reply) => ({ token: "xyz" }));
  fastify.post("/logout", async (req, reply) => ({ ok: true }));
}
`;

    fs.writeFileSync(appFile, appCode);
    fs.writeFileSync(apiFile, apiCode);
    fs.writeFileSync(authFile, authCode);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(3);

    const ping = slices.find((s) => s.route_uri === "/api/v1/ping");
    expect(ping).toBeDefined();
    expect(ping?.controller_file).toBe("src/routes/api.ts");

    const login = slices.find((s) => s.route_uri === "/api/v1/auth/login");
    expect(login).toBeDefined();
    expect(login?.http_method).toBe("POST");
    expect(login?.controller_file).toBe("src/routes/auth.ts");

    const logout = slices.find((s) => s.route_uri === "/api/v1/auth/logout");
    expect(logout).toBeDefined();
    expect(logout?.controller_file).toBe("src/routes/auth.ts");
  });

  it("resolves known schema references and does not hallucinate models for unresolved $ref", async () => {
    const appFile = path.join(tmpDir, "src/app.ts");
    fs.mkdirSync(path.dirname(appFile), { recursive: true });

    const code = `
import Fastify from "fastify";

const app = Fastify();

app.addSchema({
  $id: "userSchema",
  type: "object",
  properties: {
    name: { type: "string" }
  }
});

app.post("/known", {
  schema: {
    body: { $ref: "userSchema#" }
  }
}, (req, reply) => reply.send({}));

app.post("/unresolved", {
  schema: {
    body: { $ref: "nonExistentSchema#" }
  }
}, (req, reply) => reply.send({}));
`;
    fs.writeFileSync(appFile, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(2);

    const known = slices.find((s) => s.route_uri === "/known");
    expect(known).toBeDefined();
    const knownChain = JSON.parse(known!.execution_chain_json);
    const knownValidation = knownChain.find((c: any) => c.stage === "validation");
    expect(knownValidation).toBeDefined();
    expect(knownValidation.symbol).toBe("userSchema");
    expect(knownValidation.description).toContain("Resolved Fastify Schema: userSchema");

    const unresolved = slices.find((s) => s.route_uri === "/unresolved");
    expect(unresolved).toBeDefined();
    const unresolvedChain = JSON.parse(unresolved!.execution_chain_json);
    const unresolvedValidation = unresolvedChain.find((c: any) => c.stage === "validation");
    expect(unresolvedValidation).toBeDefined();
    expect(unresolvedValidation.symbol).toBe("unresolved:$ref");
    expect(unresolvedValidation.description).toContain("Unresolved schema reference: nonExistentSchema#");
    // Ensure no fictitious class was invented in controller_class or chain
    expect(unresolved?.controller_class).not.toContain("NonExistent");
  });

  it("handles dynamic routes safely without fabricating routes", async () => {
    const appFile = path.join(tmpDir, "src/server.ts");
    fs.mkdirSync(path.dirname(appFile), { recursive: true });

    const code = `
import Fastify from "fastify";
const app = Fastify();

const dynamicVerb = "get";
const dynamicPath = "/dynamic/" + Date.now();

app[dynamicVerb](dynamicPath, (req, reply) => reply.send("ok"));
app.get("/static", (req, reply) => reply.send("static"));
`;
    fs.writeFileSync(appFile, code);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(1);
    expect(slices[0].route_uri).toBe("/static");
  });

  it("resolves imported handler to target controller file", async () => {
    const routeFile = path.join(tmpDir, "src/routes/user.routes.ts");
    const controllerFile = path.join(tmpDir, "src/handlers/user.handler.ts");
    fs.mkdirSync(path.dirname(routeFile), { recursive: true });
    fs.mkdirSync(path.dirname(controllerFile), { recursive: true });

    fs.writeFileSync(
      controllerFile,
      `export const handleUser = async (req: any, reply: any) => reply.send("user");`
    );

    fs.writeFileSync(
      routeFile,
      `
import Fastify from "fastify";
import { handleUser } from "../handlers/user.handler";
const fastify = Fastify();
fastify.get("/profile", handleUser);
`
    );

    const slices = await extractor.extractSlices(tmpDir);
    const userSlice = slices.find((s) => s.route_uri === "/profile");
    expect(userSlice).toBeDefined();
    expect(userSlice?.controller_file).toBe("src/handlers/user.handler.ts");

    const chain = JSON.parse(userSlice!.execution_chain_json);
    const controllerNode = chain.find((c: any) => c.stage === "controller");
    expect(controllerNode?.file).toBe("src/handlers/user.handler.ts");
  });
});

