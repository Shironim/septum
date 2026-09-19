import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { IngestionPipeline } from "../../core/ingestion/pipeline.ts";

export interface SyncCommandOptions {
  json?: boolean;
}

export async function handleSyncCommand(options: SyncCommandOptions = {}): Promise<void> {
  const config = ConfigLoader.load();
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);
  const pipeline = new IngestionPipeline(repo);

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

  db.close();
}
