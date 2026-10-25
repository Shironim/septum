import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import {
  checkRuntimeVersion,
  formatUpdateNotice,
  isNewerVersion,
  parseSemver,
  readVersionCache,
  writeVersionCache,
  type RuntimeVersionMeta,
} from "../../src/utils/version-check.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ConfigLoader } from "../../src/core/config/loader.ts";
import { handleDomainTool } from "../../src/mcp/tools/domain.ts";

describe("Septum Version & Update Notification Suite", () => {
  const tmpCacheDir = path.join(os.tmpdir(), `septum-version-test-${Date.now()}`);
  const tmpCacheFile = path.join(tmpCacheDir, "version-check.json");

  // Cleanup helper
  const cleanTmp = () => {
    try {
      if (fs.existsSync(tmpCacheFile)) fs.unlinkSync(tmpCacheFile);
      if (fs.existsSync(tmpCacheDir)) fs.rmdirSync(tmpCacheDir);
    } catch {}
  };

  describe("Semver parsing and comparison", () => {
    it("correctly parses standard, v-prefixed, and prerelease versions", () => {
      expect(parseSemver("0.1.8")).toEqual([0, 1, 8]);
      expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
      expect(parseSemver("2.0.0-beta.1")).toEqual([2, 0, 0]);
      expect(parseSemver("invalid")).toEqual([0, 0, 0]);
    });

    it("evaluates isNewerVersion accurately", () => {
      expect(isNewerVersion("0.1.8", "0.1.9")).toBe(true);
      expect(isNewerVersion("0.1.8", "0.2.0")).toBe(true);
      expect(isNewerVersion("0.1.8", "1.0.0")).toBe(true);
      expect(isNewerVersion("0.1.8", "0.1.8")).toBe(false);
      expect(isNewerVersion("0.1.9", "0.1.8")).toBe(false);
      expect(isNewerVersion("1.0.0", "0.9.9")).toBe(false);
      expect(isNewerVersion("v0.1.8", "v0.1.9")).toBe(true);
    });
  });

  describe("Cache read and write operations", () => {
    it("reads and writes cache safely without throwing", () => {
      cleanTmp();
      expect(readVersionCache(tmpCacheFile)).toBeNull();

      writeVersionCache(tmpCacheFile, {
        last_checked: 1000000,
        latest_version: "0.2.0",
      });

      const entry = readVersionCache(tmpCacheFile);
      expect(entry).not.toBeNull();
      expect(entry?.last_checked).toBe(1000000);
      expect(entry?.latest_version).toBe("0.2.0");

      cleanTmp();
    });
  });

  describe("(a) Up-to-date version", () => {
    it("reports update_available=false and upgrade_command=null when on latest version", async () => {
      const meta = await checkRuntimeVersion({
        currentVersion: "0.1.8",
        fetchFn: async () => "0.1.8",
        cachePath: tmpCacheFile,
        forceRefresh: true,
      });

      expect(meta.server_version).toBe("0.1.8");
      expect(meta.latest_version).toBe("0.1.8");
      expect(meta.update_available).toBe(false);
      expect(meta.upgrade_command).toBeNull();
      expect(formatUpdateNotice(meta)).toBeNull();
    });
  });

  describe("(b) Outdated version", () => {
    it("reports update_available=true and upgrade_command when newer version exists", async () => {
      const meta = await checkRuntimeVersion({
        currentVersion: "0.1.8",
        packageName: "septum",
        fetchFn: async () => "0.2.0",
        cachePath: tmpCacheFile,
        forceRefresh: true,
      });

      expect(meta.server_version).toBe("0.1.8");
      expect(meta.latest_version).toBe("0.2.0");
      expect(meta.update_available).toBe(true);
      expect(meta.upgrade_command).toBe("bun add -g septum");

      const notice = formatUpdateNotice(meta);
      expect(notice).toBe("Update available: v0.1.8 -> v0.2.0 (Run: bun add -g septum)");
    });
  });

  describe("(c) Network timeout / offline graceful fallback", () => {
    it("falls back to null latest_version without throwing when offline and cache empty", async () => {
      const meta = await checkRuntimeVersion({
        currentVersion: "0.1.8",
        packageName: "septum",
        fetchFn: async () => {
          throw new Error("ETIMEDOUT / Offline");
        },
        cachePath: path.join(tmpCacheDir, "nonexistent.json"),
        forceRefresh: true,
      });

      expect(meta.server_version).toBe("0.1.8");
      expect(meta.latest_version).toBeNull();
      expect(meta.update_available).toBe(false);
      expect(meta.upgrade_command).toBeNull();
      expect(formatUpdateNotice(meta)).toBeNull();
    });

    it("falls back to stale cached version without throwing when network times out", async () => {
      cleanTmp();
      writeVersionCache(tmpCacheFile, {
        last_checked: Date.now() - 48 * 60 * 60 * 1000, // 48h ago (expired)
        latest_version: "0.1.9",
      });

      const meta = await checkRuntimeVersion({
        currentVersion: "0.1.8",
        packageName: "septum",
        fetchFn: async () => {
          throw new Error("Network timeout");
        },
        cachePath: tmpCacheFile,
        forceRefresh: true,
      });

      expect(meta.server_version).toBe("0.1.8");
      expect(meta.latest_version).toBe("0.1.9");
      expect(meta.update_available).toBe(true);
      expect(meta.upgrade_command).toBe("bun add -g septum");
      cleanTmp();
    });

    it("writes backoff cache on fetch failure so subsequent calls do not retry network immediately", async () => {
      cleanTmp();
      let fetchCount = 0;
      const failingFetcher = async () => {
        fetchCount++;
        throw new Error("DNS unreachable");
      };

      // Call 1: fails and writes backoff cache
      const meta1 = await checkRuntimeVersion({
        currentVersion: "0.1.8",
        fetchFn: failingFetcher,
        cachePath: tmpCacheFile,
      });
      expect(fetchCount).toBe(1);
      expect(meta1.latest_version).toBeNull();

      // Call 2: within TTL, uses backoff cache, fetcher MUST NOT be invoked again
      const meta2 = await checkRuntimeVersion({
        currentVersion: "0.1.8",
        fetchFn: failingFetcher,
        cachePath: tmpCacheFile,
      });
      expect(fetchCount).toBe(1);
      expect(meta2.latest_version).toBeNull();
      cleanTmp();
    });
  });

  describe("MCP septum_domain catalog injection", () => {
    it("attaches runtime_version and update notice to agent_instruction in macroMap", async () => {
      const db = new SeptumDatabase(":memory:");
      const repo = new SeptumRepository(db.raw);
      const config = ConfigLoader.load(undefined, process.cwd());

      // Register a mock domain so macroMap branch is triggered
      await handleDomainTool(repo, config, {
        action: "register",
        domain: "billing",
        root: "src/billing",
      });

      const result = await handleDomainTool(repo, config, {
        action: "catalog",
      });

      expect(result.content).toBeDefined();
      expect(result.runtime_version).toBeDefined();
      expect(typeof result.runtime_version.server_version).toBe("string");

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.runtime_version).toBeDefined();
      expect(parsed.index_status).toBeDefined();
      expect(parsed.index_status.runtime_version).toBeDefined();
      expect(parsed.agent_instruction).toBeDefined();
    });
  });

  describe("(d) Verification that serve mode emits zero non-JSON output to stdout", () => {
    it("spawns septum serve and verifies stdout contains exclusively valid JSON-RPC / zero raw text", async () => {
      const septumBin = path.resolve(__dirname, "../../bin/septum.ts");
      const child = spawn("bun", ["run", septumBin, "serve"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

      // Wait a moment for server initialization
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Send JSON-RPC initialize
      const initMessage = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }) + "\n";

      child.stdin.write(initMessage);

      // Wait for response
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Shutdown server
      child.stdin.end();
      await new Promise((resolve) => {
        child.on("close", resolve);
        setTimeout(() => {
          child.kill("SIGTERM");
          resolve(true);
        }, 1000);
      });

      const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");

      // Verify stdout contains ONLY valid JSON messages (separated by newline)
      const lines = stdoutRaw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty("jsonrpc", "2.0");
        // Must NEVER contain ANSI escape codes or raw terminal banners
        expect(line).not.toContain("\x1b[");
        expect(line).not.toContain("Update available:");
      }
    });
  });
});

