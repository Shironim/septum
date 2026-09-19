import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";

export async function handleQueryCommand(domainName?: string, archetype?: string, jsonOutput?: boolean): Promise<void> {
  const config = ConfigLoader.load();
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);

  if (!domainName) {
    const allDomains = repo.getAllDomains();
    if (allDomains.length === 0) {
      console.log("[Septum] No domains found in database. Run 'septum ingest' first.");
      db.close();
      return;
    }

    console.log("=== Registered Domains in Septum ===");
    for (const d of allDomains) {
      console.log(`- ${d.name} (root: ${d.root_path})`);
    }
    db.close();
    return;
  }

  const catalog = repo.getDomainCatalog(domainName, archetype);
  if (!catalog) {
    console.error(`[Septum Error] Domain '${domainName}' not found in database. Run 'septum ingest' first.`);
    db.close();
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(catalog, null, 2));
  } else {
    console.log(`=================================================`);
    console.log(`  Domain: ${catalog.domain.toUpperCase()} (Root: ${catalog.root})`);
    console.log(`=================================================`);
    console.log(`  Allowed Dependencies:    [${catalog.allowed_dependencies.join(", ")}]`);
    console.log(`  Forbidden Dependencies:  [${catalog.forbidden_dependencies.join(", ")}]`);
    console.log(`  Total Files Cataloged:   ${catalog.files.length}`);
    console.log(`-------------------------------------------------`);

    for (const file of catalog.files) {
      console.log(`\n  File: ${file.path} [archetype: ${file.archetype}]`);
      for (const sym of file.symbols) {
        console.log(`    • ${sym.kind.toUpperCase()} ${sym.name}`);
        if (sym.methods && sym.methods.length > 0) {
          for (const m of sym.methods) {
            console.log(`        - ${m}`);
          }
        }
        if (sym.signatures && sym.signatures.length > 0) {
          for (const s of sym.signatures) {
            console.log(`        - ${s}`);
          }
        }
      }
    }
    console.log(`\n=================================================`);
  }

  db.close();
}
