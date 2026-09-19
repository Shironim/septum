import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { SymbolLocator } from "../../core/resolver/symbol-locator.ts";

export async function handleLocateCommand(
  query: string,
  options?: { domain?: string; json?: boolean }
): Promise<void> {
  const config = ConfigLoader.load();
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);

  try {
    const locator = new SymbolLocator(repo);
    const result = locator.locate(query, options?.domain);

    if (options?.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.found) {
      console.log(`\n✅ Symbol Found:`);
      console.log(`   File:      ${result.file_path}`);
      if (result.exact_symbol) {
        console.log(`   Symbol:    ${result.exact_symbol.name} [${result.exact_symbol.kind}]`);
        console.log(`   Signature: ${result.exact_symbol.signature}`);
        console.log(`   Lines:     ${result.exact_symbol.line_start} - ${result.exact_symbol.line_end}`);
      }
      if (result.sibling_methods && result.sibling_methods.length > 0) {
        console.log(`\n   Available Methods in Container:`);
        console.log(`   ${result.sibling_methods.join(", ")}`);
      }
    } else {
      console.log(`\n❌ Diagnostic Result:`);
      if (result.file_path) {
        console.log(`   File:      ${result.file_path}`);
        console.log(`   Container: ${result.container_name}`);
      }
      console.log(`   Message:   ${result.message}`);

      if (result.sibling_methods && result.sibling_methods.length > 0) {
        console.log(`\n   Available Methods:`);
        console.log(`   ${result.sibling_methods.join(", ")}`);
      }

      if (result.suggestions.length > 0) {
        console.log(`\n   Suggestions (Ranked by Match):`);
        for (const sug of result.suggestions) {
          const matchPercent = Math.round(sug.similarity_score * 100);
          console.log(
            `   • ${sug.name} (${matchPercent}% match) [line ${sug.line_start}] -> ${sug.signature}`
          );
        }
      }
    }
  } finally {
    db.close();
  }
}
