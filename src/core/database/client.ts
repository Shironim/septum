import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initializeDatabaseSchema } from "./schema.ts";

export class SeptumDatabase {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string = ".septum/septum.db") {
    this.dbPath = dbPath;
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    try {
      this.db = new Database(dbPath, { create: true });
      this.configurePragmas();
      this.initSchema();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not a database|database disk image is malformed|file is not a database|malformed database schema/i.test(message)) {
        throw new Error(`SQLite database at '${dbPath}' appears corrupt: ${message}. Stop Septum, back up the database and any matching -wal/-shm files, then diagnose or restore the backup manually. Septum did not remove or replace the files.`);
      }
      throw error;
    }
  }

  private configurePragmas(): void {
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA busy_timeout = 5000;");
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run("PRAGMA synchronous = NORMAL;");
  }

  private initSchema(): void {
    initializeDatabaseSchema(this.db);
  }

  public get raw(): Database {
    return this.db;
  }

  public close(): void {
    this.db.close();
  }

  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  public checkpoint(): void {
    try {
      this.db.run("PRAGMA wal_checkpoint(PASSIVE);");
    } catch {
      // Ignore if locked or busy
    }
  }
}
