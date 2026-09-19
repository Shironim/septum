import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
    const schemaFile = join(import.meta.dir, "schema.sql");
    if (existsSync(schemaFile)) {
      const sql = readFileSync(schemaFile, "utf-8");
      this.db.run(sql);
    } else {
      // Fallback inline schema if schema.sql is not found in compiled bundle
      this.db.run(`
        CREATE TABLE IF NOT EXISTS domains (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          root_path TEXT NOT NULL,
          allowed_deps_json TEXT NOT NULL DEFAULT '[]',
          forbidden_deps_json TEXT NOT NULL DEFAULT '[]',
          archetypes_json TEXT NOT NULL DEFAULT '{}',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain_id INTEGER NOT NULL,
          path TEXT NOT NULL UNIQUE,
          archetype TEXT NOT NULL DEFAULT 'unknown',
          content_hash TEXT NOT NULL,
          line_count INTEGER NOT NULL DEFAULT 0,
          last_scanned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS symbols (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          signature TEXT NOT NULL,
          visibility TEXT NOT NULL DEFAULT 'public',
          line_start INTEGER NOT NULL DEFAULT 0,
          line_end INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS dependencies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_file_id INTEGER NOT NULL,
          target_symbol_or_path TEXT NOT NULL,
          import_statement TEXT NOT NULL,
          line_number INTEGER NOT NULL DEFAULT 0,
          is_external BOOLEAN NOT NULL DEFAULT 0,
          FOREIGN KEY (source_file_id) REFERENCES files(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS vertical_slices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain_id INTEGER,
          feature_key TEXT,
          http_method TEXT NOT NULL,
          route_uri TEXT NOT NULL,
          route_name TEXT,
          controller_class TEXT NOT NULL,
          action_name TEXT NOT NULL,
          controller_file TEXT,
          controller_line INTEGER DEFAULT 0,
          architecture_style TEXT NOT NULL DEFAULT 'clean',
          entry_kind TEXT NOT NULL DEFAULT 'http_route',
          execution_chain_json TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_slices_route_uri ON vertical_slices(route_uri);
        CREATE INDEX IF NOT EXISTS idx_slices_route_name ON vertical_slices(route_name);
        CREATE INDEX IF NOT EXISTS idx_slices_controller ON vertical_slices(controller_class, action_name);
        CREATE TABLE IF NOT EXISTS repo_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    }
    this.migrateSchema();
  }

  private migrateSchema(): void {
    try {
      const tableInfo = this.db.query<{ name: string }, []>("PRAGMA table_info(vertical_slices)").all();
      const existingCols = new Set(tableInfo.map((c) => c.name));

      if (tableInfo.length > 0) {
        if (existingCols.has("form_request_class") || !existingCols.has("execution_chain_json")) {
          this.db.run("DROP TABLE IF EXISTS vertical_slices;");
          this.initSchema();
        }
      }
    } catch (_) {
      // Ignore migration errors
    }
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
