import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import type { DomainCatalogResponse } from "../../types/index.ts";

export interface QueryCommandOptions {
  json?: boolean;
  full?: boolean;
  file?: string;
}

export async function handleQueryCommand(
  domainName?: string,
  archetype?: string,
  jsonOutputOrOptions?: boolean | QueryCommandOptions,
  extraOptions?: QueryCommandOptions
): Promise<void> {
  const options: QueryCommandOptions =
    typeof jsonOutputOrOptions === "boolean"
      ? { json: jsonOutputOrOptions, ...extraOptions }
      : { ...jsonOutputOrOptions, ...extraOptions };

  const jsonOutput = Boolean(options.json);
  const detailLevel: "compact" | "full" = options.full ? "full" : "compact";
  const fileFilter = options.file;

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

  const catalog: DomainCatalogResponse | null = (repo.getDomainCatalog as any)(
    domainName,
    archetype,
    { detailLevel, fileFilter }
  );
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
    console.log(`  Detail Level:            ${catalog.detail_level ?? detailLevel}`);
    console.log(`  Allowed Dependencies:    [${catalog.allowed_dependencies.join(", ")}]`);
    console.log(`  Forbidden Dependencies:  [${catalog.forbidden_dependencies.join(", ")}]`);
    console.log(`  Total Files Cataloged:   ${catalog.total_files ?? catalog.files.length} (Showing: ${catalog.showing_files ?? catalog.files.length})`);
    console.log(`-------------------------------------------------`);

    for (const file of catalog.files) {
      const lineInfo = file.line_count ? `, ${file.line_count} lines` : "";
      console.log(`\n  File: ${file.path} [archetype: ${file.archetype}${lineInfo}]`);
      if (file.connections) {
        const importsStr = file.connections.imports_from.length > 0 ? file.connections.imports_from.join(", ") : "none";
        console.log(`    ↔ Connections: imports [${importsStr}] | imported by ${file.connections.imported_by_count} file(s)`);
      }
      for (const sym of file.symbols) {
        const spanStr = sym.line_span ? ` (L${sym.line_span})` : "";
        const countsStr =
          sym.methods_count !== undefined
            ? ` [${sym.methods_count} methods${sym.properties_count ? `, ${sym.properties_count} props` : ""}]`
            : "";
        console.log(`    • ${sym.kind.toUpperCase()} ${sym.name}${spanStr}${countsStr}`);
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
    if (catalog.agent_hint) {
      console.log(`\n  💡 ${catalog.agent_hint}`);
    }
    console.log(`\n=================================================`);
  }

  db.close();
}

