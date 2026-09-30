import { describe, expect, it } from "bun:test";
import { EnvironmentDetector } from "../../src/core/topology/environment-detector.ts";
import { handleGetEnvironmentTopology } from "../../src/mcp/tools/get-environment-topology.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Self-Aware Environment Topology Plane", () => {
  it("should detect baseline environment layers and surface ambiguous layers", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-topo-test-"));
    const dbPath = path.join(tmpDir, ".septum", "septum.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new SeptumDatabase(dbPath);
    const repo = new SeptumRepository(db.raw);

    const topology = EnvironmentDetector.detect(tmpDir, repo);
    expect(topology.layers).toBeDefined();
    expect(topology.layers.edge).toBeDefined();
    expect(topology.layers.gateway).toBeDefined();
    expect(topology.layers.host).toBeDefined();
    expect(topology.layers.runtime).toBeDefined();
    expect(topology.layers.storage).toBeDefined();
    expect(topology.layers.telemetry).toBeDefined();
    expect(topology.pending_inquiries.length).toBeGreaterThan(0);
  });

  it("should persist layer resolution to SQLite SSOT and mark layer as VERIFIED", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-topo-test-"));
    const dbPath = path.join(tmpDir, ".septum", "septum.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new SeptumDatabase(dbPath);
    const repo = new SeptumRepository(db.raw);

    repo.environment.saveLayer({
      layer: "edge",
      platform: "Cloudflare WAF",
      canonical_tag: "cdn_edge",
      status: "VERIFIED",
      detected_from: ["Manual Test"],
      constraints: ["Rate limit strict mode enabled"],
    });

    const retrieved = repo.environment.getLayer("edge");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.status).toBe("VERIFIED");
    expect(retrieved?.platform).toBe("Cloudflare WAF");
    expect(retrieved?.constraints).toContain("Rate limit strict mode enabled");

    const refreshed = EnvironmentDetector.detect(tmpDir, repo);
    expect(refreshed.layers.edge.status).toBe("VERIFIED");
    expect(refreshed.layers.edge.platform).toBe("Cloudflare WAF");
  });

  it("should handle distributed nodes and persist them in topology graph", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-topo-test-"));
    const dbPath = path.join(tmpDir, ".septum", "septum.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new SeptumDatabase(dbPath);
    const repo = new SeptumRepository(db.raw);

    repo.environment.saveNode({
      id: "host:worker-1",
      layer: "host",
      name: "Dedicated Background Worker",
      platform: "Ubuntu VPS 24.04",
      canonical_tag: "vps",
      status: "VERIFIED",
      detected_from: ["Manual Add"],
      constraints: ["Isolated queue worker node"],
    });

    const allNodes = repo.environment.getAllNodes();
    expect(allNodes.some((n) => n.id === "host:worker-1")).toBe(true);

    repo.environment.deleteNode("host:worker-1");
    const afterDelete = repo.environment.getAllNodes();
    expect(afterDelete.some((n) => n.id === "host:worker-1")).toBe(false);
  });

  it("should execute handleGetEnvironmentTopology tool without errors", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-topo-test-"));
    const dbPath = path.join(tmpDir, ".septum", "septum.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new SeptumDatabase(dbPath);
    const repo = new SeptumRepository(db.raw);

    const dummyConfig: ValidatedSeptumConfig = {
      version: "1.0",
      settings: {
        strict_mode: true,
        db_path: dbPath,
        telemetry: false,
      },
      domains: {},
    };

    const response = await handleGetEnvironmentTopology(repo, dummyConfig, {}, tmpDir);
    expect(response.content).toBeDefined();
    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text).toContain("Septum Environment & Topology Plane");
  });
});
