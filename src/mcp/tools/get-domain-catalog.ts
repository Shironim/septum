import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";

export interface GetDomainCatalogArgs {
  domain?: string;
  archetype_filter?: string;
}

export function handleGetDomainCatalog(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: GetDomainCatalogArgs
) {
  if (!args.domain) {
    const allDomains = repo.getAllDomains();
    const projectType = repo.getMeta("project_type") || "generic";
    const framework = repo.getMeta("framework") || "unknown";
    const archStyle = repo.getMeta("architecture_style") || "modular";
    const totalSlices = repo.getAllVerticalSlices().length;

    const macroMap = {
      telescope_view: {
        project_type: projectType,
        framework,
        architecture_style: archStyle,
        total_domains: allDomains.length,
        total_vertical_slices: totalSlices,
      },
      domains: allDomains.map((d) => ({
        name: d.name,
        root: d.root_path,
        archetypes: Object.keys(JSON.parse(d.archetypes_json || "{}")),
        allowed_dependencies: JSON.parse(d.allowed_deps_json || "[]"),
        forbidden_dependencies: JSON.parse(d.forbidden_deps_json || "[]"),
      })),
      agent_instruction:
        "Macro semantic map loaded from SQLite SSOT. Use 'septum_get_domain_catalog' with domain='<name>' for granular file/symbol catalogs, or 'septum_trace_vertical_slice' with query='<route|command|intent>' for end-to-end execution flow.",
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(macroMap, null, 2),
        },
      ],
    };
  }

  const catalog = repo.getDomainCatalog(args.domain, args.archetype_filter);
  if (!catalog) {
    const available = Object.keys(config.domains).join(", ");
    throw new Error(
      `Domain '${args.domain}' not found. Available domains in Septum catalog: [${available}]. Run 'septum ingest' or 'septum_register_domain' if recently added.`
    );
  }

  // Record access log for Gate 3 (Mandatory Catalog Consultation)
  recordCatalogAccess(args.domain);

  // Token-efficient serialization: keep payload dense and under 500 tokens
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(catalog, null, 2),
      },
    ],
  };
}

function recordCatalogAccess(domain: string): void {
  try {
    const septumDir = path.resolve(process.cwd(), ".septum");
    if (!fs.existsSync(septumDir)) {
      fs.mkdirSync(septumDir, { recursive: true });
    }
    const logPath = path.join(septumDir, "catalog_access.json");
    let log: { domains?: Record<string, string>; features?: Record<string, string> } = {};
    if (fs.existsSync(logPath)) {
      try {
        log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
      } catch {}
    }
    log.domains = log.domains || {};
    log.domains[domain] = new Date().toISOString();
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf-8");
  } catch {}
}
