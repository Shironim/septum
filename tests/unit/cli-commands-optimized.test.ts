import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

describe("Optimized 7 CLI Commands Suite", () => {
  const septumBin = join(import.meta.dir, "../../bin/septum.ts");

  it("lists exactly the 7 supported commands in --help", () => {
    const res = spawnSync("bun", ["run", septumBin, "--help"], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(res.status).toBe(0);
    const output = res.stdout || "";

    // The 7 active commands must be present
    expect(output).toContain("init");
    expect(output).toContain("sync");
    expect(output).toContain("check");
    expect(output).toContain("feature");
    expect(output).toContain("hook");
    expect(output).toContain("topology");
    expect(output).toContain("serve");

    // The 4 removed commands must NOT be listed under COMMANDS
    expect(output).not.toContain("ingest ");
    expect(output).not.toContain("query [domain]");
    expect(output).not.toContain("locate <query>");
    expect(output).not.toContain("slice <route|intent>");
  });

  it("rejects removed commands with exit code 1", () => {
    const removedCommands = ["ingest", "query", "locate", "slice"];

    for (const cmd of removedCommands) {
      const res = spawnSync("bun", ["run", septumBin, cmd], {
        encoding: "utf-8",
        timeout: 5000,
      });

      expect(res.status).toBe(1);
      const combined = (res.stdout || "") + (res.stderr || "");
      expect(combined).toContain(`[Septum] Unknown command: '${cmd}'`);
    }
  });

  it("runs sync command without errors", () => {
    const res = spawnSync("bun", ["run", septumBin, "sync", "--json"], {
      encoding: "utf-8",
      timeout: 10000,
    });

    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.files_scanned).toBeDefined();
    expect(parsed.symbols_indexed).toBeDefined();
  });
});

