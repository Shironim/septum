import * as path from "node:path";
import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { IngestionPipeline } from "../../core/ingestion/pipeline.ts";
import { resolveWorkspaceRoot } from "../../core/resolver/path-resolver.ts";

export interface SyncCommandOptions {
  json?: boolean;
  workspaceRoot?: string;
  dbPath?: string;
}

export async function handleSyncCommand(options: SyncCommandOptions = {}): Promise<void> {
  const root = resolveWorkspaceRoot(options.workspaceRoot || process.cwd());
  const config = ConfigLoader.load(options.dbPath, root);
  const resolvedDbPath = options.dbPath
    ? (path.isAbsolute(options.dbPath) ? options.dbPath : path.join(root, options.dbPath))
    : (path.isAbsolute(config.settings.db_path) ? config.settings.db_path : path.join(root, config.settings.db_path));
  const db = new SeptumDatabase(resolvedDbPath);
  try {
    const repo = new SeptumRepository(db.raw);
    const pipeline = new IngestionPipeline(repo, root);

    const metrics = await pipeline.run(config);

    if (options.json) {
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      console.log(
        `[Septum Sync] Ingested in ${metrics.duration_ms.toFixed(0)}ms: ` +
          `${metrics.files_updated} updated/added, ` +
          `${metrics.files_skipped} unchanged, ` +
          `${metrics.symbols_indexed} symbols, ` +
          `${metrics.dependencies_indexed} deps.`
      );
    }
  } finally {
    db.close();
  }
}
