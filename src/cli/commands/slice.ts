import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { VerticalSliceTracer } from "../../core/resolver/vertical-slice-tracer.ts";

export async function handleSliceCommand(
  query: string,
  options?: { json?: boolean }
): Promise<void> {
  const config = ConfigLoader.load();
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);

  try {
    const tracer = new VerticalSliceTracer(repo);
    const result = tracer.trace(query);

    if (options?.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.found) {
      console.log(`\n${result.message}\n`);
      if (result.alternatives && result.alternatives.length > 0) {
        console.log(`  • Alternative Matches:`);
        for (const alt of result.alternatives) {
          console.log(`      - ${alt.method} ${alt.uri} -> ${alt.controller}@${alt.action}`);
        }
        console.log(``);
      }
    } else {
      console.log(`\n❌ Vertical Slice Not Found:`);
      console.log(`   Query:   ${result.query}`);
      console.log(`   Message: ${result.message}`);

      if (result.alternatives && result.alternatives.length > 0) {
        console.log(`\n   Available Slices:`);
        for (const alt of result.alternatives) {
          console.log(`      - ${alt.method} ${alt.uri} -> ${alt.controller}@${alt.action}`);
        }
      }
      console.log(``);
    }
  } finally {
    db.close();
  }
}
