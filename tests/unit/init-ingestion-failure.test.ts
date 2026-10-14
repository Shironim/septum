import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { handleInitCommand } from "../../src/cli/commands/init.ts";

describe("F2-05: Initial Ingestion Failure Propagation and Partial State Reporting", () => {
  it("should fail and reject with recovery instructions when config loading fails during init", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-init-config-err-"));
    try {
      // Setup simple source files
      fs.mkdirSync(path.join(tmpDir, "src", "billing"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src", "billing", "Invoice.ts"), "export const invoice = 1;", "utf-8");

      // Inject corrupt features_json in .septum/septum.db before init
      fs.mkdirSync(path.join(tmpDir, ".septum"), { recursive: true });
      const db = new SeptumDatabase(path.join(tmpDir, ".septum", "septum.db"));
      const repo = new SeptumRepository(db.raw);
      repo.setMeta("features_json", "{bad feature JSON");
      db.close();

      const septumBin = path.resolve(__dirname, "../../bin/septum.ts");
      const res = spawnSync("bun", ["run", septumBin, "init"], {
        cwd: tmpDir,
        encoding: "utf-8",
        timeout: 10000,
        input: "\n",
      });

      // Must exit non-zero
      expect(res.status).not.toBe(0);
      const combinedOutput = (res.stdout || "") + (res.stderr || "");

      // Must NOT claim full success
      expect(combinedOutput).not.toContain("Septum successfully initialized and ready for production use");

      // Must report partial state and failure
      expect(combinedOutput).toContain("Initial codebase ingestion failed");
      expect(combinedOutput).toContain("Configuration Loading");
      expect(combinedOutput).toContain("Partial Initialization State");
      expect(combinedOutput).toContain("Recovery Instruction");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should exit non-zero and report partial state via CLI process when pipeline fails", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-init-pipe-err-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "src", "orders"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src", "orders", "Order.ts"), "export const order = 1;", "utf-8");

      // Inject settings_json with invalid ignore_pattern [null] to trigger pipeline error
      fs.mkdirSync(path.join(tmpDir, ".septum"), { recursive: true });
      const db = new SeptumDatabase(path.join(tmpDir, ".septum", "septum.db"));
      const repo = new SeptumRepository(db.raw);
      repo.setMeta("settings_json", JSON.stringify({ ignore_patterns: [null] }));
      db.close();

      const septumBin = path.resolve(__dirname, "../../bin/septum.ts");
      const res = spawnSync("bun", ["run", septumBin, "init"], {
        cwd: tmpDir,
        encoding: "utf-8",
        timeout: 10000,
      });

      // Must exit non-zero
      expect(res.status).not.toBe(0);
      const combinedOutput = (res.stdout || "") + (res.stderr || "");

      // Must NOT claim full success
      expect(combinedOutput).not.toContain("Septum successfully initialized and ready for production use");

      // Must report partial state and failure
      expect(combinedOutput).toContain("Initial codebase ingestion failed");
      expect(combinedOutput).toContain("Partial Initialization State");
      expect(combinedOutput).toContain("Recovery Instruction");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
