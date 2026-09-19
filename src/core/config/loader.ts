import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { ValidatedSeptumConfig } from "./schema.ts";
import { TopologyDetector } from "../discovery/topology-detector.ts";
import { SeptumDatabase } from "../database/client.ts";
import { SeptumRepository } from "../database/repository.ts";

export class ConfigLoader {
  /**
   * Loads configuration with SQLite as the Single Source of Truth (SSOT).
   * Automatically executes Zero-Config TopologyDetector if the database has no domains.
   */
  public static load(dbPath: string = ".septum/septum.db"): ValidatedSeptumConfig {
    // 1. If database exists and has registered domains, load directly from SQLite SSOT
    if (existsSync(dbPath)) {
      const dbConfig = ConfigLoader.loadFromDatabaseOrDefaults(dbPath);
      if (Object.keys(dbConfig.domains).length > 0) {
        return dbConfig;
      }
    }

    // 2. Zero-Config Auto-Discovery: Discover project topology and persist to SQLite
    const septumDb = new SeptumDatabase(dbPath);
    const repo = new SeptumRepository(septumDb.raw);
    TopologyDetector.discoverAndPersist(repo, process.cwd());
    septumDb.close();

    return ConfigLoader.loadFromDatabaseOrDefaults(dbPath);
  }

  public static getDefaultConfig(): ValidatedSeptumConfig {
    return {
      version: "1.0",
      settings: {
        enforcement: "warn",
        db_path: ".septum/septum.db",
        ignore_patterns: [
          "node_modules/**",
          "vendor/**",
          "dist/**",
          "build/**",
          "tests/**",
          ".git/**",
          ".septum/**",
        ],
      },
      domains: {},
      features: {},
    };
  }

  public static loadFromDatabaseOrDefaults(dbPath: string = ".septum/septum.db"): ValidatedSeptumConfig {
    const config = ConfigLoader.getDefaultConfig();
    config.settings.db_path = dbPath;

    if (existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        const tables = db
          .query<{ name: string }, [string]>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
          )
          .get("domains");

        if (tables) {
          const rows = db.query<any, []>("SELECT * FROM domains").all();
          for (const r of rows) {
            config.domains[r.name] = {
              root: r.root_path,
              allowed_dependencies: JSON.parse(r.allowed_deps_json || "[]"),
              forbidden_dependencies: JSON.parse(r.forbidden_deps_json || "[]"),
              archetypes: JSON.parse(r.archetypes_json || "{}"),
            };
          }
        }
        db.close();
      } catch {
        // Fallback gracefully to default config
      }
    }

    return config;
  }
}
