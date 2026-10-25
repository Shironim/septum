import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";
import type { ValidatedSeptumConfig } from "./schema.ts";
import { TopologyDetector } from "../discovery/topology-detector.ts";
import { SeptumDatabase } from "../database/client.ts";
import { SeptumRepository } from "../database/repository.ts";
import { resolveWorkspaceRoot, isAppHostDirectory } from "../resolver/path-resolver.ts";

export class ConfigLoader {
  /**
   * Loads configuration with SQLite as the Single Source of Truth (SSOT).
   * Automatically executes Zero-Config TopologyDetector if the database has no domains.
   */
  public static load(
    dbPath?: string,
    projectRoot?: string
  ): ValidatedSeptumConfig {
    const root = resolveWorkspaceRoot(projectRoot);
    const resolvedDbPath = dbPath
      ? (isAbsolute(dbPath) ? dbPath : join(root, dbPath))
      : join(root, ".septum", "septum.db");

    // 1. If database exists and has registered domains, load directly from SQLite SSOT
    if (existsSync(resolvedDbPath)) {
      const dbConfig = ConfigLoader.loadFromDatabaseOrDefaults(resolvedDbPath);
      if (Object.keys(dbConfig.domains).length > 0) {
        return dbConfig;
      }
    }

    // 2. Zero-Config Auto-Discovery: Discover project topology and persist to SQLite
    // Guard against running auto-discovery inside MCP host / IDE installation folders
    if (!isAppHostDirectory(root)) {
      const septumDb = new SeptumDatabase(resolvedDbPath);
      const repo = new SeptumRepository(septumDb.raw);
      TopologyDetector.discoverAndPersist(repo, root);
      septumDb.close();
    }

    return ConfigLoader.loadFromDatabaseOrDefaults(resolvedDbPath);
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
          "out/**",
          "target/**",
          "coverage/**",
          ".venv/**",
          "venv/**",
          "__pycache__/**",
          "tests/**",
          "scripts/**",
          "bin/**",
          ".git/**",
          ".septum/**",
        ],
      },
      domains: {},
      features: {},
    };
  }

  public static loadFromRepository(repo: SeptumRepository): ValidatedSeptumConfig {
    const config = ConfigLoader.getDefaultConfig();
    if (repo && typeof repo.getAllDomains === "function") {
      const rows = repo.getAllDomains();
      for (const row of rows) {
        config.domains[row.name] = {
          root: row.root_path,
          allowed_dependencies: JSON.parse(row.allowed_deps_json || "[]"),
          forbidden_dependencies: JSON.parse(row.forbidden_deps_json || "[]"),
          archetypes: JSON.parse(row.archetypes_json || "{}"),
        };
      }
    }

    if (typeof repo?.getMeta === "function") {
      const features = repo.getMeta("features_json");
      if (features) config.features = JSON.parse(features);
      const settings = repo.getMeta("settings_json");
      if (settings) Object.assign(config.settings, JSON.parse(settings));
    }
    return config;
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

        try {
          if (tables) Object.assign(config, ConfigLoader.loadFromRepository(new SeptumRepository(db)));
          config.settings.db_path = dbPath;
        } finally {
          db.close();
        }
      } catch {
        throw new Error(`Cannot load Septum configuration from '${dbPath}'.`);
      }
    }

    return config;
  }
}
