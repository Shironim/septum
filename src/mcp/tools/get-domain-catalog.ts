import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";

export interface GetDomainCatalogArgs {
  domain?: string;
  archetype_filter?: string;
  workspace_path?: string;
}

export function handleGetDomainCatalog(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: GetDomainCatalogArgs,
  workspaceRoot?: string
) {
  const targetRoot = args.workspace_path || workspaceRoot || (repo as any)?.projectRoot || process.cwd();

  if (!args.domain) {
    const allDomains = repo.getAllDomains();
    if (allDomains.length === 0) {
      const root = targetRoot;
      const diagnostic = {
        status: "NOT_INDEXED",
        total_domains: 0,
        message: `Workspace '${root}' belum memiliki domain terdaftar dalam Septum catalog.`,
        suggested_action: {
          tool: "septum_register_domain",
          params: {
            name: "core",
            root: "src",
            ingest_now: true,
          },
        },
        agent_guidance:
          "Panggil tool 'septum_register_domain(name: \"core\", root: \"src\", ingest_now: true)' untuk mendaftarkan dan mengindeks domain utama secara otomatis, atau jalankan 'septum init' di terminal workspace.",
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(diagnostic, null, 2),
          },
        ],
        metadata: diagnostic,
      };
    }

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
    const available = Object.keys(config.domains || {});
    const suggestions = available.filter((d) =>
      d.toLowerCase().includes(args.domain!.toLowerCase()) ||
      args.domain!.toLowerCase().includes(d.toLowerCase())
    );
    const notFoundPayload = {
      status: "not_found",
      found: false,
      domain: args.domain,
      message: `Domain '${args.domain}' not found in Septum catalog.`,
      available_domains: available,
      suggestions: suggestions.length > 0 ? suggestions : available,
      suggested_action: {
        tool: "septum_register_domain",
        params: { domain: args.domain, root: `src/domains/${args.domain}` },
      },
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(notFoundPayload, null, 2),
        },
      ],
      metadata: notFoundPayload,
    };
  }

  // Record access log for Gate 3 (Mandatory Catalog Consultation)
  recordCatalogAccess(args.domain, targetRoot);

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

function recordCatalogAccess(domain: string, projectRoot: string = process.cwd()): void {
  try {
    const septumDir = path.resolve(projectRoot, ".septum");
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
