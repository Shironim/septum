import { RESOLVER_REVISION } from "../../core/resolver/import-resolver.ts";
import { getParserCapabilities } from "../../core/parser/language-capabilities.ts";
import { SemanticSliceExtractorRegistry } from "../../core/parser/extractors/registry.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { DomainCatalogResponse } from "../../types/index.ts";
import type { GetDomainCatalogArgs } from "../schemas.ts";
import { checkRuntimeVersion, getCachedRuntimeVersion } from "../../utils/version-check.ts";

export type { GetDomainCatalogArgs } from "../schemas.ts";

export function handleGetDomainCatalog(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: GetDomainCatalogArgs,
  workspaceRoot?: string
) {
  const targetRoot = args.workspace_path || workspaceRoot || (repo as any)?.projectRoot || process.cwd();
  const domainName = args.domain ?? args.name;
  const runtimeVersion = getCachedRuntimeVersion();
  // Non-blocking background version refresh if needed
  void checkRuntimeVersion().catch(() => {});
  const parserCapabilities = {
    ...getParserCapabilities(args.detail_level === "full"),
    analysis_contracts: { foundation_revision: "1", resolver_revision: RESOLVER_REVISION, relationships: "imports-v1", semantic_lifecycle: "async-v1" },
    semantic_adapters: args.detail_level === "full"
      ? SemanticSliceExtractorRegistry.getCapabilities()
      : SemanticSliceExtractorRegistry.getCapabilities().map(adapter => adapter.id),
    semantic_limits: "Registered adapters cover selected static patterns; registration does not prove applicability, AST backing, complete routes or runtime calls.",
  };
  const isDirty = repo.getMeta("slices_dirty") === "1";
  const indexStatus = {
    runtime_version: runtimeVersion,
    unsupported_files: JSON.parse(repo.getMeta("unsupported_files") || "[]"),
    watcher_mode: repo.getMeta("watcher_mode") || "manual",
    sync_state: repo.getMeta("sync_state") || "unknown",
    sync_needed: isDirty,
    skipped_files: JSON.parse(repo.getMeta("skipped_files") || "[]"),
  };

  if (!domainName) {
    const allDomains = repo.getAllDomains();
    if (allDomains.length === 0) {
      const root = targetRoot;
      let agentGuidance =
        "Panggil tool 'septum_domain(action: \"register\", name: \"core\", root: \"src\", ingest_now: true)' untuk mendaftarkan dan mengindeks domain utama secara otomatis, atau jalankan 'septum init' di terminal workspace.";
      if (runtimeVersion.update_available) {
        agentGuidance += ` Update available: v${runtimeVersion.server_version} -> v${runtimeVersion.latest_version}. Recommend running '${runtimeVersion.upgrade_command}' and reloading the MCP server if schema/features differ.`;
      }
      const diagnostic = {
        status: "NOT_INDEXED",
        parser_capabilities: parserCapabilities,
        total_domains: 0,
        runtime_version: runtimeVersion,
        message: `Workspace '${root}' belum memiliki domain terdaftar dalam Septum catalog.`,
        suggested_action: {
          tool: "septum_domain",
          params: {
            action: "register",
            name: "core",
            root: "src",
            ingest_now: true,
          },
        },
        agent_guidance: agentGuidance,
        ...(runtimeVersion.update_available
          ? {
              agent_instruction: `Update available: v${runtimeVersion.server_version} -> v${runtimeVersion.latest_version}. Recommend running '${runtimeVersion.upgrade_command}' and reloading the MCP server if schema/features differ.`,
            }
          : {}),
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(diagnostic, null, 2),
          },
        ],
        metadata: diagnostic,
        runtime_version: runtimeVersion,
      };
    }

    const projectType = repo.getMeta("project_type") || "generic";
    const framework = repo.getMeta("framework") || "unknown";
    const archStyle = repo.getMeta("architecture_style") || "modular";
    const totalSlices =
      typeof (repo as any).countVerticalSlices === "function"
        ? (repo as any).countVerticalSlices()
        : repo.getAllVerticalSlices().length;

    let agentInstruction =
      "Macro semantic map loaded from SQLite SSOT. Use 'septum_domain' with domain='<name>' for granular file/symbol catalogs, or 'septum_slice' with query='<route|command|intent>' for end-to-end execution flow.";
    if (isDirty) {
      agentInstruction += " Notice: Index has pending or unsynchronized file changes. Run 'septum sync' to ensure all symbol coordinates and call graphs are fully refreshed.";
    }
    if (runtimeVersion.update_available) {
      agentInstruction += ` Update available: v${runtimeVersion.server_version} -> v${runtimeVersion.latest_version}. Recommend running '${runtimeVersion.upgrade_command}' and reloading the MCP server if schema/features differ.`;
    }

    const macroMap = {
      parser_capabilities: parserCapabilities,
      runtime_version: runtimeVersion,
      index_status: indexStatus,
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
      agent_instruction: agentInstruction,
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(macroMap, null, 2),
        },
      ],
      metadata: { runtime_version: runtimeVersion },
      runtime_version: runtimeVersion,
    };
  }

  const archetypeFilter = args.archetype_filter ?? args.archetype;
  const detailLevel = args.detail_level ?? "compact";
  const fileFilter = args.file_filter;

  const catalog: DomainCatalogResponse | null = (repo.getDomainCatalog as any)(
    domainName,
    archetypeFilter,
    { detailLevel, fileFilter, workspaceRoot: targetRoot }
  );
  if (!catalog) {
    const available = Object.keys(config.domains || {});
    const suggestions = available.filter((d) =>
      d.toLowerCase().includes(domainName.toLowerCase()) ||
      domainName.toLowerCase().includes(d.toLowerCase())
    );
    const notFoundPayload: Record<string, any> = {
      status: "not_found",
      parser_capabilities: parserCapabilities,
      found: false,
      domain: domainName,
      runtime_version: runtimeVersion,
      message: `Domain '${domainName}' not found in Septum catalog.`,
      available_domains: available,
      suggestions: suggestions.length > 0 ? suggestions : available,
      suggested_action: {
        tool: "septum_domain",
        params: { action: "register", domain: domainName, root: `src/domains/${domainName}` },
      },
    };
    if (runtimeVersion.update_available) {
      notFoundPayload.agent_instruction = `Update available: v${runtimeVersion.server_version} -> v${runtimeVersion.latest_version}. Recommend running '${runtimeVersion.upgrade_command}' and reloading the MCP server if schema/features differ.`;
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(notFoundPayload, null, 2),
        },
      ],
      metadata: notFoundPayload,
      runtime_version: runtimeVersion,
    };
  }

  // Record access log for Gate 3 (Mandatory Catalog Consultation)
  recordCatalogAccess(domainName, targetRoot);

  const catalogPayload: Record<string, any> = {
    ...catalog,
    ...(args.detail_level === "full" ? { relationships: repo.getImportRelationships(targetRoot).filter(edge => catalog.files.some(file => file.path === edge.source.file)) } : {}),
    parser_capabilities: parserCapabilities,
    runtime_version: runtimeVersion,
    index_status: indexStatus,
  };
  if (runtimeVersion.update_available) {
    catalogPayload.agent_instruction = `Update available: v${runtimeVersion.server_version} -> v${runtimeVersion.latest_version}. Recommend running '${runtimeVersion.upgrade_command}' and reloading the MCP server if schema/features differ.`;
  }

  // Compact catalogs omit per-language capability details.
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(catalogPayload, null, 2),
      },
    ],
    metadata: { runtime_version: runtimeVersion },
    runtime_version: runtimeVersion,
  };
}

function recordCatalogAccess(domain: string, projectRoot: string = process.cwd()): void {
  try {
    const septumDir = path.resolve(projectRoot, ".septum");
    if (!fs.existsSync(septumDir)) {
      return;
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
