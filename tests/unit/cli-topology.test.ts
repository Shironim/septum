import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { handleTopologyCommand } from "../../src/cli/commands/topology.ts";

describe("F1-04: CLI Topology Input Validation & Error Handling", () => {
  const testDir = join(import.meta.dir, "../fixtures/cli_topology_test");
  const dbPath = join(testDir, ".septum/septum.db");

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, ".septum"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("rejects unknown topology subcommands without creating or mutating DB", async () => {
    let error: Error | null = null;
    try {
      await handleTopologyCommand("wrong-action", undefined, undefined, undefined, undefined, testDir);
    } catch (err: any) {
      error = err;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/Unknown topology subcommand: 'wrong-action'/);
    // DB should not be created if validation happens before DB initialization
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects incomplete resolve without arguments", async () => {
    let error: Error | null = null;
    try {
      await handleTopologyCommand("resolve", undefined, undefined, undefined, undefined, testDir);
    } catch (err: any) {
      error = err;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/Missing required arguments for 'topology resolve'/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects incomplete resolve with missing platform argument", async () => {
    let error: Error | null = null;
    try {
      await handleTopologyCommand("resolve", "host", undefined, undefined, undefined, testDir);
    } catch (err: any) {
      error = err;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/Missing required arguments for 'topology resolve'/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects invalid environment layer in resolve", async () => {
    let error: Error | null = null;
    try {
      await handleTopologyCommand("resolve", "not-a-layer", "demo", undefined, undefined, testDir);
    } catch (err: any) {
      error = err;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/Invalid environment layer 'not-a-layer'/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects incomplete add-node without arguments", async () => {
    let error: Error | null = null;
    try {
      await handleTopologyCommand("add-node", undefined, undefined, undefined, undefined, testDir);
    } catch (err: any) {
      error = err;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/Missing required arguments for 'topology add-node'/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects add-node with invalid layer", async () => {
    let error: Error | null = null;
    try {
      await handleTopologyCommand("add-node", "worker-1", "invalid-layer", "Docker", undefined, testDir);
    } catch (err: any) {
      error = err;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/Invalid environment layer 'invalid-layer'/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects incomplete remove-node without node id", async () => {
    let error: Error | null = null;
    try {
      await handleTopologyCommand("remove-node", undefined, undefined, undefined, undefined, testDir);
    } catch (err: any) {
      error = err;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/Missing required argument for 'topology remove-node'/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("successfully verifies valid layer resolve and persists in SQLite SSOT", async () => {
    await handleTopologyCommand("resolve", "host", "Docker", undefined, undefined, testDir);

    const db = new SeptumDatabase(dbPath);
    const repo = new SeptumRepository(db.raw);
    const layer = repo.environment.getLayer("host");
    db.close();

    expect(layer).not.toBeNull();
    expect(layer?.platform).toBe("Docker");
    expect(layer?.status).toBe("VERIFIED");
  });

  it("successfully adds node, removes node, and clears topology", async () => {
    await handleTopologyCommand("add-node", "worker-node", "host", "Docker", "10.0.0.2", testDir);

    const db1 = new SeptumDatabase(dbPath);
    const repo1 = new SeptumRepository(db1.raw);
    const node = repo1.environment.getNode("worker-node");
    db1.close();

    expect(node).not.toBeNull();
    expect(node?.id).toBe("worker-node");
    expect(node?.layer).toBe("host");
    expect(node?.platform).toBe("Docker");
    expect(node?.domain_or_ip).toBe("10.0.0.2");

    // Remove node
    await handleTopologyCommand("remove-node", "worker-node", undefined, undefined, undefined, testDir);
    const db2 = new SeptumDatabase(dbPath);
    const repo2 = new SeptumRepository(db2.raw);
    const removed = repo2.environment.getNode("worker-node");
    db2.close();
    expect(removed).toBeNull();

    // Clear
    await handleTopologyCommand("clear", undefined, undefined, undefined, undefined, testDir);
  });

  it("renders default topology plane when no subcommand is specified", async () => {
    // Should run detect without throwing error
    await handleTopologyCommand(undefined, undefined, undefined, undefined, undefined, testDir);
    expect(existsSync(dbPath)).toBe(true);
  });
});
