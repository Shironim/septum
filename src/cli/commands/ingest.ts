import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { IngestionPipeline } from "../../core/ingestion/pipeline.ts";

export async function handleIngestCommand(): Promise<void> {
  console.log("[Septum] Starting codebase structural ingestion...");

  const config = ConfigLoader.load();
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);
  const pipeline = new IngestionPipeline(repo);

  const metrics = await pipeline.run(config);

  console.log("=========================================");
  console.log("  Septum Ingestion Complete");
  console.log("=========================================");
  console.log(`  Domains Processed:     ${metrics.domains_processed}`);
  console.log(`  Files Scanned:         ${metrics.files_scanned}`);
  console.log(`  Files Updated/Added:   ${metrics.files_updated}`);
  console.log(`  Files Cached/Skipped:  ${metrics.files_skipped}`);
  console.log(`  Symbols Indexed:       ${metrics.symbols_indexed}`);
  console.log(`  Dependencies Indexed:  ${metrics.dependencies_indexed}`);
  console.log(`  Execution Time:        ${metrics.duration_ms} ms`);
  console.log("=========================================");

  db.close();
}
