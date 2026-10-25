import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FlaskSemanticExtractor } from "../../src/core/parser/extractors/flask-semantic.ts";

describe("Python Semantic Slice Extractor (Flask L1-L3)", () => {
  let tmpDir: string;
  const extractor = new FlaskSemanticExtractor();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-flask-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects Flask topology from requirements.txt and extracts direct app routes", async () => {
    fs.writeFileSync(path.join(tmpDir, "requirements.txt"), "Flask==3.0.2\ngunicorn\n");
    expect(extractor.canHandle(tmpDir)).toBe(true);

    const appCode = `
from flask import Flask, render_template, request

app = Flask(__name__)

@app.route("/health")
def health_check():
    return {"status": "ok"}

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        return {"status": "authenticated"}
    return render_template("login.html")

@app.post("/api/v1/orders")
def create_order():
    return {"order_id": 123}, 201
`;
    fs.writeFileSync(path.join(tmpDir, "app.py"), appCode);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(4);

    // 1. GET /health
    const health = slices.find((s) => s.route_uri === "/health");
    expect(health).toBeDefined();
    expect(health?.http_method).toBe("GET");
    expect(health?.action_name).toBe("health_check");
    expect(health?.controller_file).toBe("app.py");

    const healthChain = JSON.parse(health!.execution_chain_json);
    expect(healthChain.some((c: any) => c.stage === "ingress" && c.symbol === "GET /health")).toBe(true);
    expect(healthChain.some((c: any) => c.stage === "controller" && c.symbol === "app::health_check")).toBe(true);

    // 2. Multi-method route /login (GET and POST)
    const loginGet = slices.find((s) => s.route_uri === "/login" && s.http_method === "GET");
    const loginPost = slices.find((s) => s.route_uri === "/login" && s.http_method === "POST");
    expect(loginGet).toBeDefined();
    expect(loginPost).toBeDefined();

    const loginChain = JSON.parse(loginGet!.execution_chain_json);
    expect(loginChain.some((c: any) => c.stage === "egress" && c.symbol === "login.html")).toBe(true);

    // 3. Flask 2.0+ shorthand @app.post
    const order = slices.find((s) => s.route_uri === "/api/v1/orders" && s.http_method === "POST");
    expect(order).toBeDefined();
    expect(order?.action_name).toBe("create_order");
  });

  it("resolves multi-file Blueprints registered with prefix composition", async () => {
    fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), '[project]\ndependencies = ["flask>=3.0"]\n');
    expect(extractor.canHandle(tmpDir)).toBe(true);

    const routesDir = path.join(tmpDir, "routes");
    fs.mkdirSync(routesDir, { recursive: true });

    // 1. Blueprint declaration in routes/users.py
    const userRouteCode = `
from flask import Blueprint

user_bp = Blueprint("users", __name__, url_prefix="/users")

@user_bp.route("/", methods=["GET"])
def list_users():
    return []

@user_bp.route("/<int:user_id>", methods=["GET"])
def get_user(user_id):
    return {"id": user_id}
`;
    fs.writeFileSync(path.join(routesDir, "users.py"), userRouteCode);

    // 2. Blueprint registration in main.py with url_prefix="/api/v1"
    const mainCode = `
from flask import Flask
from routes.users import user_bp

app = Flask(__name__)
app.register_blueprint(user_bp, url_prefix="/api/v1")
`;
    fs.writeFileSync(path.join(tmpDir, "main.py"), mainCode);

    const slices = await extractor.extractSlices(tmpDir);
    expect(slices).toHaveLength(2);

    const listSlice = slices.find((s) => s.route_uri === "/api/v1/users/");
    expect(listSlice).toBeDefined();
    expect(listSlice?.http_method).toBe("GET");
    expect(listSlice?.controller_class).toBe("users");
    expect(listSlice?.action_name).toBe("list_users");
    expect(listSlice?.controller_file).toBe("routes/users.py");

    const getSlice = slices.find((s) => s.route_uri === "/api/v1/users/<int:user_id>");
    expect(getSlice).toBeDefined();
    expect(getSlice?.controller_file).toBe("routes/users.py");
    expect(getSlice?.action_name).toBe("get_user");
  });
});

