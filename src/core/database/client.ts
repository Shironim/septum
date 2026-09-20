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

    this.db = new Database(dbPath, { create: true });
    this.configurePragmas();
    this.initSchema();
  }

  private configurePragmas(): void {
    this.db.run("PRAGMA journal_mode = WAL;");
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
}
