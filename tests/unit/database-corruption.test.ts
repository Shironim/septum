import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SeptumDatabase } from "../../src/core/database/client.ts";

describe("SQLite corruption diagnostics", () => {
  it("reports corrupt files with backup guidance and leaves their bytes untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "septum-corrupt-db-"));
    const file = join(root, "septum.db");
    const bytes = Buffer.from("not a sqlite database");
    writeFileSync(file, bytes);
    try {
      expect(() => new SeptumDatabase(file)).toThrow(/appears corrupt.*back up the database.*-wal\/-shm/i);
      expect(readFileSync(file)).toEqual(bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("diagnoses a truncated SQLite database without deleting it", () => {
    const root = mkdtempSync(join(tmpdir(), "septum-truncated-db-"));
    const file = join(root, "septum.db");
    const db = new SeptumDatabase(file); db.close();
    const bytes = readFileSync(file).subarray(0, 32); writeFileSync(file, bytes);
    try {
      expect(() => new SeptumDatabase(file)).toThrow(/appears corrupt/);
      expect(readFileSync(file)).toEqual(bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
