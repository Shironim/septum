import { z } from "zod";

function withAliases(raw: unknown, aliases: Record<string, string>): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  for (const [alias, target] of Object.entries(aliases)) {
    if (obj[alias] !== undefined && obj[target] === undefined) {
      obj[target] = obj[alias];
    }
  }
  return obj;
}

export function extractSingleStringFallback(
  raw: unknown,
  targetField: string,
  ignoredKeys: string[] = ["workspace_path", "workspacePath", "workspace", "project_root", "projectRoot"]
): unknown {
  if (typeof raw === "string") {
    return { [targetField]: raw };
  }
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "string") {
    return { [targetField]: raw[0] };
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const obj = { ...(raw as Record<string, unknown>) };
    if (obj[targetField] !== undefined && typeof obj[targetField] === "string" && (obj[targetField] as string).trim() !== "") {
      return obj;
    }
    const nonIgnoredEntries = Object.entries(obj).filter(
      ([key, val]) => !ignoredKeys.includes(key) && typeof val === "string" && (val as string).trim() !== ""
    );
    if (nonIgnoredEntries.length === 1) {
      obj[targetField] = nonIgnoredEntries[0][1];
    }
    return obj;
  }
  return raw;
}

export function normalizeFeatureContextArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "feature_key");
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = { ...(coerced as Record<string, unknown>) };

  const aliases: Record<string, string> = {
    feature: "feature_key",
    featureKey: "feature_key",
    feature_name: "feature_key",
    featureName: "feature_key",
    feat: "feature_key",
    name: "feature_key",
    key: "feature_key",
    task: "feature_key",
    task_name: "feature_key",
    target: "feature_key",
    context: "feature_key",
    slug: "feature_key",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  };

  for (const [alias, target] of Object.entries(aliases)) {
    if (obj[alias] !== undefined && obj[target] === undefined) {
      obj[target] = obj[alias];
    }
  }

  // Populate feature as backward-compatible alias
  if (obj.feature_key !== undefined && obj.feature === undefined) {
    obj.feature = obj.feature_key;
  } else if (obj.feature !== undefined && obj.feature_key === undefined) {
    obj.feature_key = obj.feature;
  }

  return obj;
}

export function normalizeBoundaryArgs(raw: unknown): unknown {
  if (Array.isArray(raw) && raw.length > 1 && raw.every((item) => typeof item === "string")) {
    raw = { file_paths: raw };
  }
  const coerced = extractSingleStringFallback(raw, "file_path", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "scope",
    "domain",
    "domain_name",
    "domainName",
    "feature_key",
    "featureKey",
    "feature",
    "feature_name",
    "featureName",
    "name",
    "key",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = { ...(coerced as Record<string, unknown>) };
  const aliases: Record<string, string> = {
    filePath: "file_path",
    file: "file_path",
    path: "file_path",
    from_file: "file_path",
    fromFile: "file_path",
    source_file: "file_path",
    sourceFile: "file_path",
    filePaths: "file_paths",
    files: "file_paths",
    paths: "file_paths",
    proposedImports: "proposed_imports",
    imports: "proposed_imports",
    featureKey: "feature_key",
    feature: "feature_key",
    feature_name: "feature_key",
    featureName: "feature_key",
    name: "feature_key",
    key: "feature_key",
    domain_name: "domain",
    domainName: "domain",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  };
  for (const [alias, target] of Object.entries(aliases)) {
    if (obj[alias] !== undefined && obj[target] === undefined) {
      obj[target] = obj[alias];
    }
  }

  if (obj.feature_key !== undefined && obj.feature === undefined) {
    obj.feature = obj.feature_key;
  } else if (obj.feature !== undefined && obj.feature_key === undefined) {
    obj.feature_key = obj.feature;
  }

  if (obj.to_file || obj.toFile) {
    const rawTo = obj.to_file ?? obj.toFile;
    const toFiles = Array.isArray(rawTo) ? rawTo.map(String) : [String(rawTo)];
    if (!obj.proposed_imports) {
      obj.proposed_imports = toFiles;
    } else if (Array.isArray(obj.proposed_imports)) {
      obj.proposed_imports = [...obj.proposed_imports, ...toFiles];
    }
  }
  if (Array.isArray(obj.file_path) && !obj.file_paths) {
    obj.file_paths = obj.file_path;
    delete obj.file_path;
  }
  if (typeof obj.file_paths === "string" && !obj.file_path) {
    obj.file_path = obj.file_paths;
    delete obj.file_paths;
  }
  if (obj.scope === undefined) {
    if (obj.staged === true) {
      obj.scope = "staged";
    } else if (obj.domain !== undefined && obj.file_path === undefined && obj.file_paths === undefined) {
      obj.scope = "domain";
    }
  }
  return obj;
}

export function normalizeDomainCatalogArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "domain", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "target_path",
    "path",
    "archetype_filter",
    "archetype",
    "archetypeFilter",
    "type",
    "detail_level",
    "detailLevel",
    "mode",
    "format",
    "file_filter",
    "fileFilter",
    "file",
    "filter",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    domain_name: "domain",
    domainName: "domain",
    name: "domain",
    archetype: "archetype_filter",
    archetypeFilter: "archetype_filter",
    type: "archetype_filter",
    detailLevel: "detail_level",
    mode: "detail_level",
    format: "detail_level",
    fileFilter: "file_filter",
    file: "file_filter",
    filter: "file_filter",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
    target_path: "workspace_path",
    path: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.domain !== undefined && obj.name === undefined) {
    obj.name = obj.domain;
  } else if (obj.name !== undefined && obj.domain === undefined) {
    obj.domain = obj.name;
  }
  if (obj.archetype_filter !== undefined && obj.archetype === undefined) {
    obj.archetype = obj.archetype_filter;
  } else if (obj.archetype !== undefined && obj.archetype_filter === undefined) {
    obj.archetype_filter = obj.archetype;
  }
  if (obj.full === true && obj.detail_level === undefined) {
    obj.detail_level = "full";
  }
  return obj;
}

export const GetDomainCatalogSchema = z.preprocess(
  normalizeDomainCatalogArgs,
  z.object({
    domain: z.string().optional(),
    name: z.string().optional(),
    archetype_filter: z.string().optional(),
    archetype: z.string().optional(),
    detail_level: z.enum(["compact", "full"]).optional().default("compact"),
    file_filter: z.string().optional(),
    workspace_path: z.string().optional(),
  })
);
export type GetDomainCatalogArgs = z.infer<typeof GetDomainCatalogSchema>;

export const GetFeatureContextSchema = z.preprocess(
  normalizeFeatureContextArgs,
  z.object({
    feature_key: z.string().optional(),
    feature: z.string().optional(),
    workspace_path: z.string().optional(),
  })
);
export type GetFeatureContextArgs = z.infer<typeof GetFeatureContextSchema>;

export const ClearFeatureContextSchema = z
  .object({
    workspace_path: z.string().optional(),
  })
  .passthrough();
export type ClearFeatureContextArgs = z.infer<typeof ClearFeatureContextSchema>;

export function normalizeLocateSymbolArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "query", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "target_path",
    "path",
    "domain",
    "domain_name",
    "domainName",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    symbol: "query",
    name: "query",
    symbol_name: "query",
    symbolName: "query",
    target: "query",
    domain_name: "domain",
    domainName: "domain",
    max: "limit",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
    target_path: "workspace_path",
    path: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  } else if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  }
  if (!obj.query && !obj.symbol && typeof obj.symbol_ref === "object" && obj.symbol_ref !== null) {
    obj.query = (obj.symbol_ref as Record<string, unknown>).name;
    obj.symbol = obj.query;
  }
  return obj;
}

export const SymbolReferenceSchema = z.object({
  file_path: z.string().min(1), language: z.string().min(1), name: z.string().min(1), kind: z.string().min(1),
  signature: z.string(), start_line: z.number().int().positive(), end_line: z.number().int().positive(),
  indexed_content_hash: z.string().min(1), container: z.string().optional(), receiver: z.string().optional(),
}).refine(ref => ref.end_line >= ref.start_line, { message: "end_line must be at or after start_line" });

export const LocateSymbolSchema = z.preprocess(
  normalizeLocateSymbolArgs,
  z.object({
    query: z.string().min(1, "query is required"),
    symbol: z.string().optional(),
    domain: z.string().optional(),
    symbol_ref: SymbolReferenceSchema.optional(),
    file_path: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional().default(10),
    workspace_path: z.string().optional(),
  })
);
export type LocateSymbolArgs = z.infer<typeof LocateSymbolSchema>;

export function normalizeGetSymbolArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "symbol", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "domain",
    "domain_name",
    "domainName",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    query: "symbol",
    name: "symbol",
    symbol_name: "symbol",
    symbolName: "symbol",
    target: "symbol",
    domain_name: "domain",
    domainName: "domain",
    includeDependencies: "include_dependencies",
    include_deps: "include_dependencies",
    includeDeps: "include_dependencies",
    dependencies: "include_dependencies",
    deps: "include_dependencies",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  } else if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  }
  if (!obj.query && !obj.symbol && typeof obj.symbol_ref === "object" && obj.symbol_ref !== null) {
    obj.query = (obj.symbol_ref as Record<string, unknown>).name;
    obj.symbol = obj.query;
  }
  return obj;
}

export const GetSymbolSchema = z.preprocess(
  normalizeGetSymbolArgs,
  z.object({
    symbol: z.string().min(1, "symbol is required"),
    query: z.string().optional(),
    domain: z.string().optional(),
    symbol_ref: SymbolReferenceSchema.optional(),
    include_dependencies: z.boolean().optional().default(true),
    workspace_path: z.string().optional(),
    file_path: z.string().min(1).optional(),
    include_source: z.boolean().optional().default(false),
    source_start_line: z.number().int().positive().optional(),
    source_line_limit: z.number().int().positive().max(200).optional().default(120),
  })
);
export type GetSymbolArgs = z.infer<typeof GetSymbolSchema>;

export function normalizeGetSymbolImpactArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "symbol");
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    query: "symbol",
    name: "symbol",
    symbol_name: "symbol",
    symbolName: "symbol",
    file_path: "symbol",
    filePath: "symbol",
    file: "symbol",
    path: "symbol",
    target: "symbol",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  } else if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  }
  return obj;
}

export const GetSymbolImpactSchema = z.preprocess(
  normalizeGetSymbolImpactArgs,
  z.object({
    symbol: z.string().min(1, "symbol is required"),
    query: z.string().optional(),
    domain: z.string().optional(),
    workspace_path: z.string().optional(),
  })
);
export type GetSymbolImpactArgs = z.infer<typeof GetSymbolImpactSchema>;

export function normalizeTraceVerticalSliceArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "query");
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    route: "query",
    uri: "query",
    route_uri: "query",
    routeUri: "query",
    entry_file: "query",
    entryFile: "query",
    file_path: "query",
    filePath: "query",
    file: "query",
    path: "query",
    symbol: "query",
    name: "query",
    feature: "query",
    feature_key: "query",
    featureKey: "query",
    maxDepth: "max_depth",
    depth: "max_depth",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  } else if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  }
  if (obj.max_depth !== undefined && obj.max_depth !== null && !Number.isNaN(Number(obj.max_depth))) {
    obj.max_depth = Math.min(Math.max(Math.trunc(Number(obj.max_depth)), 1), 8);
  }
  return obj;
}

export const TraceVerticalSliceSchema = z.preprocess(
  normalizeTraceVerticalSliceArgs,
  z.object({
    query: z.string().min(1, "query is required"),
    symbol: z.string().optional(),
    max_depth: z.number().int().min(1).max(8).optional().default(5),
    workspace_path: z.string().optional(),
  })
);
export type TraceVerticalSliceArgs = z.infer<typeof TraceVerticalSliceSchema>;

export const CheckBoundarySchema = z.preprocess(
  normalizeBoundaryArgs,
  z.object({
    file_path: z.string().trim().min(1, "file_path cannot be blank").optional(),
    file_paths: z.array(z.string().trim().min(1, "file_paths cannot contain blank paths")).optional(),
    proposed_imports: z.array(z.string()).optional().default([]),
    feature_key: z.string().optional(),
    scope: z.enum(["file", "all", "staged", "domain"]).optional(),
    domain: z.string().trim().min(1, "domain cannot be blank").optional(),
    staged: z.boolean().optional(),
    workspace_path: z.string().optional(),
  }).superRefine((args, ctx) => {
    const hasBatch = Boolean(args.file_paths?.length);
    const hasTarget = args.file_path !== undefined || hasBatch;
    const scope = args.scope ?? (args.staged ? "staged" : hasTarget ? "file" : args.domain ? "domain" : "all");
    if (args.file_path !== undefined && hasBatch) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["file_paths"], message: "Use either file_path or file_paths, not both." });
    }
    if (args.staged && scope !== "staged") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["staged"], message: "staged=true requires scope='staged'." });
    }
    if (scope === "file" && !hasTarget) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["file_path"], message: "scope='file' requires file_path or non-empty file_paths." });
    }
    if (scope !== "file" && hasTarget) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: `scope='${scope}' does not accept file targets. Use scope='file' for proposed-import checks.` });
    }
    if (scope === "domain" && !args.domain) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["domain"], message: "scope='domain' requires a registered domain name." });
    }
    if (scope === "all" && args.domain) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["domain"], message: "scope='all' checks the entire repository. Use scope='domain' to filter a domain." });
    }
    if (scope !== "file" && args.proposed_imports.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["proposed_imports"], message: "proposed_imports requires a file target and scope='file'." });
    }
  })
);
export type CheckBoundaryArgs = z.infer<typeof CheckBoundarySchema>;

export const GetSymbolHotspotsSchema = z.preprocess(
  (args) =>
    withAliases(args, {
      domain_name: "domain",
      domainName: "domain",
      max: "limit",
      nesting: "min_nesting",
      minNesting: "min_nesting",
      lines: "min_lines",
      minLines: "min_lines",
      sortBy: "sort_by",
      workspace: "workspace_path",
      workspacePath: "workspace_path",
      project_root: "workspace_path",
      projectRoot: "workspace_path",
    }),
  z.object({
    min_lines: z.number().int().nonnegative().optional(),
    min_nesting: z.number().int().positive().optional(),
    kind: z.string().optional(),
    domain: z.string().optional(),
    limit: z.number().int().positive().optional().default(30),
    sort_by: z.enum(["lines", "nesting", "risk_score"]).optional(),
    workspace_path: z.string().optional(),
  })
);
export type GetSymbolHotspotsArgs = z.infer<typeof GetSymbolHotspotsSchema>;

export function normalizeRegisterDomainArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "domain", [
    "root",
    "root_path",
    "rootPath",
    "path",
    "root_dir",
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    name: "domain",
    domain_name: "domain",
    domainName: "domain",
    root_path: "root",
    rootPath: "root",
    path: "root",
    allowedDependencies: "allowed_dependencies",
    allowed: "allowed_dependencies",
    forbiddenDependencies: "forbidden_dependencies",
    forbidden: "forbidden_dependencies",
    archetype: "archetypes",
    ingestNow: "ingest_now",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.domain !== undefined && obj.name === undefined) {
    obj.name = obj.domain;
  } else if (obj.name !== undefined && obj.domain === undefined) {
    obj.domain = obj.name;
  }
  return obj;
}

export const RegisterDomainSchema = z.preprocess(
  normalizeRegisterDomainArgs,
  z.object({
    domain: z.string().min(1, "Domain name/identifier is required"),
    name: z.string().optional(),
    root: z.string().min(1, "Domain root path is required"),
    description: z.string().optional(),
    allowed_dependencies: z.array(z.string()).optional(),
    forbidden_dependencies: z.array(z.string()).optional(),
    archetypes: z.record(z.string()).optional(),
    ingest_now: z.boolean().optional().default(false),
    workspace_path: z.string().optional(),
  })
);
export type RegisterDomainArgs = z.infer<typeof RegisterDomainSchema>;

export function normalizeRegisterFeatureArgs(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };

  const aliases: Record<string, string> = {
    feature: "feature_key",
    featureKey: "feature_key",
    feature_name: "feature_key",
    featureName: "feature_key",
    feat: "feature_key",
    name: "feature_key",
    key: "feature_key",
    domain_name: "domain",
    domainName: "domain",
    touchpoints: "allowed_touchpoints",
    allowedTouchpoints: "allowed_touchpoints",
    touchpoint: "allowed_touchpoints",
    files: "allowed_touchpoints",
    allowed_files: "allowed_touchpoints",
    reuseSymbols: "reuse_symbols",
    reuse: "reuse_symbols",
    symbols: "reuse_symbols",
    inputContract: "input_contract",
    outputContract: "output_contract",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  };

  for (const [alias, target] of Object.entries(aliases)) {
    if (obj[alias] !== undefined && obj[target] === undefined) {
      obj[target] = obj[alias];
    }
  }

  // Symmetrical contract: feature_key <-> feature
  if (obj.feature_key !== undefined && obj.feature === undefined) {
    obj.feature = obj.feature_key;
  } else if (obj.feature !== undefined && obj.feature_key === undefined) {
    obj.feature_key = obj.feature;
  }

  // Symmetrical contract: domain <-> domain_name
  if (obj.domain !== undefined && obj.domain_name === undefined) {
    obj.domain_name = obj.domain;
  } else if (obj.domain_name !== undefined && obj.domain === undefined) {
    obj.domain = obj.domain_name;
  }

  // Array coercion for allowed_touchpoints
  if (typeof obj.allowed_touchpoints === "string") {
    obj.allowed_touchpoints = [obj.allowed_touchpoints];
  } else if (!Array.isArray(obj.allowed_touchpoints) && obj.allowed_touchpoints !== undefined) {
    obj.allowed_touchpoints = [];
  }

  // Array coercion for reuse_symbols
  if (typeof obj.reuse_symbols === "string") {
    obj.reuse_symbols = [obj.reuse_symbols];
  }

  return obj;
}

export const RegisterFeatureSchema = z.preprocess(
  normalizeRegisterFeatureArgs,
  z.object({
    feature_key: z.string().min(1, "Feature key is required"),
    feature: z.string().optional(),
    domain: z.string().min(1, "Domain name is required"),
    domain_name: z.string().optional(),
    description: z.string().optional(),
    allowed_touchpoints: z.array(z.string()).default([]),
    reuse_symbols: z.array(z.string()).optional(),
    input_contract: z.record(z.unknown()).optional(),
    output_contract: z.record(z.unknown()).optional(),
    workspace_path: z.string().optional(),
  })
);
export type RegisterFeatureArgs = z.infer<typeof RegisterFeatureSchema>;

function normalizeTopologyArgs(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = withAliases(raw, {
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;
  if (obj.resolve_node !== undefined && obj.resolveNode === undefined) {
    obj.resolveNode = obj.resolve_node;
  }
  if (obj.resolve_layer !== undefined && obj.resolve === undefined) {
    obj.resolve = obj.resolve_layer;
  }
  if (obj.resolveLayer !== undefined && obj.resolve === undefined) {
    obj.resolve = obj.resolveLayer;
  }
  if (typeof obj.resolveNode === "object" && obj.resolveNode !== null) {
    obj.resolveNode = withAliases(obj.resolveNode, {
      canonicalTag: "canonical_tag",
      domainOrIp: "domain_or_ip",
      connectedTo: "connected_to",
      nodeId: "id",
      node_id: "id",
      nodeName: "name",
      node_name: "name",
    });
  }
  return obj;
}

export const GetEnvironmentTopologySchema = z.preprocess(
  (args) => normalizeTopologyArgs(args),
  z.object({
    resolve: z
      .object({
        layer: z.enum(["edge", "gateway", "host", "runtime", "storage", "telemetry"]),
        platform: z.string().min(1, "platform name cannot be empty"),
        constraints: z.array(z.string()).optional(),
      })
      .optional(),
    resolveNode: z
      .object({
        id: z.string().min(1, "Node id cannot be empty"),
        layer: z.enum(["edge", "gateway", "host", "runtime", "storage", "telemetry"]),
        name: z.string().min(1, "Node name cannot be empty"),
        platform: z.string().min(1, "Platform cannot be empty"),
        canonical_tag: z
          .enum([
            "shared_hosting",
            "vps",
            "docker",
            "serverless",
            "kubernetes",
            "managed_db",
            "cdn_edge",
            "paas",
            "static_cdn",
            "unspecified",
          ])
          .optional(),
        domain_or_ip: z.string().optional(),
        role: z.string().optional(),
        constraints: z.array(z.string()).optional(),
        connected_to: z.array(z.string()).optional(),
      })
      .optional(),
    refresh: z.boolean().optional().default(false),
    workspace_path: z.string().optional(),
  })
);
export type GetEnvironmentTopologyArgs = z.infer<typeof GetEnvironmentTopologySchema>;

// =========================================================================
// 5 UNIFIED TOOLS SCHEMAS & NORMALIZERS (Refactored Clean-Break MCP Engine)
// =========================================================================

// 1. septum_domain
export function normalizeDomainToolArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "domain", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "target_path",
    "path",
    "action",
    "detail_level",
    "detailLevel",
    "mode",
    "format",
    "archetype_filter",
    "archetype",
    "file_filter",
    "fileFilter",
    "root",
    "root_path",
    "rootPath",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    domain_name: "domain",
    domainName: "domain",
    name: "domain",
    archetype: "archetype_filter",
    archetypeFilter: "archetype_filter",
    type: "archetype_filter",
    detailLevel: "detail_level",
    mode: "detail_level",
    format: "detail_level",
    fileFilter: "file_filter",
    file: "file_filter",
    filter: "file_filter",
    root_path: "root",
    rootPath: "root",
    path: "root",
    allowedDependencies: "allowed_dependencies",
    allowed: "allowed_dependencies",
    forbiddenDependencies: "forbidden_dependencies",
    forbidden: "forbidden_dependencies",
    archetypes: "archetypes",
    ingestNow: "ingest_now",
    resolveLayer: "resolve",
    resolve_layer: "resolve",
    resolveNode: "resolve_node",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  }) as Record<string, unknown>;

  if (obj.domain !== undefined && obj.name === undefined) {
    obj.name = obj.domain;
  } else if (obj.name !== undefined && obj.domain === undefined) {
    obj.domain = obj.name;
  }

  if (obj.archetype_filter !== undefined && obj.archetype === undefined) {
    obj.archetype = obj.archetype_filter;
  } else if (obj.archetype !== undefined && obj.archetype_filter === undefined) {
    obj.archetype_filter = obj.archetype;
  }

  if (obj.full === true && obj.detail_level === undefined) {
    obj.detail_level = "full";
  }

  if (typeof obj.resolve_node === "object" && obj.resolve_node !== null) {
    obj.resolve_node = withAliases(obj.resolve_node, {
      canonicalTag: "canonical_tag",
      domainOrIp: "domain_or_ip",
      connectedTo: "connected_to",
      nodeId: "id",
      node_id: "id",
      nodeName: "name",
      node_name: "name",
    });
  }

  if (!obj.action) {
    if (obj.root !== undefined || obj.ingest_now !== undefined) {
      obj.action = "register";
    } else if (obj.resolve !== undefined || obj.resolve_node !== undefined || obj.resolveNode !== undefined || obj.refresh !== undefined) {
      obj.action = "topology";
    } else {
      obj.action = "catalog";
    }
  }

  return obj;
}

export const DomainToolSchema = z.preprocess(
  normalizeDomainToolArgs,
  z.object({
    action: z.enum(["catalog", "register", "topology"]).optional().default("catalog"),
    domain: z.string().optional(),
    name: z.string().optional(),
    detail_level: z.enum(["compact", "full"]).optional().default("compact"),
    archetype_filter: z.string().optional(),
    archetype: z.string().optional(),
    file_filter: z.string().optional(),
    root: z.string().optional(),
    description: z.string().optional(),
    allowed_dependencies: z.array(z.string()).optional(),
    forbidden_dependencies: z.array(z.string()).optional(),
    archetypes: z.record(z.string()).optional(),
    ingest_now: z.boolean().optional().default(false),
    resolve: z
      .object({
        layer: z.enum(["edge", "gateway", "host", "runtime", "storage", "telemetry"]),
        platform: z.string().min(1, "platform name cannot be empty"),
        constraints: z.array(z.string()).optional(),
      })
      .optional(),
    resolve_node: z
      .object({
        id: z.string().min(1, "Node id cannot be empty"),
        layer: z.enum(["edge", "gateway", "host", "runtime", "storage", "telemetry"]),
        name: z.string().min(1, "Node name cannot be empty"),
        platform: z.string().min(1, "Platform cannot be empty"),
        canonical_tag: z
          .enum([
            "shared_hosting",
            "vps",
            "docker",
            "serverless",
            "kubernetes",
            "managed_db",
            "cdn_edge",
            "paas",
            "static_cdn",
            "unspecified",
          ])
          .optional(),
        domain_or_ip: z.string().optional(),
        role: z.string().optional(),
        constraints: z.array(z.string()).optional(),
        connected_to: z.array(z.string()).optional(),
      })
      .optional(),
    resolveNode: z.any().optional(),
    refresh: z.boolean().optional().default(false),
    workspace_path: z.string().optional(),
  })
);
export type DomainToolArgs = z.infer<typeof DomainToolSchema>;

// 2. septum_symbol
export function normalizeSymbolToolArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "query", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "action",
    "domain",
    "domain_name",
    "domainName",
    "min_lines",
    "min_nesting",
    "sort_by",
    "limit",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = withAliases(coerced, {
    symbol: "query",
    name: "query",
    symbol_name: "query",
    symbolName: "query",
    target: "query",
    domain_name: "domain",
    domainName: "domain",
    includeDependencies: "include_dependencies",
    include_deps: "include_dependencies",
    includeDeps: "include_dependencies",
    dependencies: "include_dependencies",
    deps: "include_dependencies",
    max: "limit",
    nesting: "min_nesting",
    minNesting: "min_nesting",
    lines: "min_lines",
    minLines: "min_lines",
    sortBy: "sort_by",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
    filePath: "file_path",
    sourceStartLine: "source_start_line",
    sourceLineLimit: "source_line_limit",
  }) as Record<string, unknown>;

  if (obj.query !== undefined && obj.symbol === undefined) {
    obj.symbol = obj.query;
  } else if (obj.symbol !== undefined && obj.query === undefined) {
    obj.query = obj.symbol;
  }

  if (!obj.action) {
    if (obj.min_lines !== undefined || obj.min_nesting !== undefined || obj.kind !== undefined || (obj.sort_by && !obj.query)) {
      obj.action = "hotspots";
    } else if (obj.include_dependencies !== undefined) {
      obj.action = "inspect";
    } else {
      obj.action = "locate";
    }
  }

  if (!obj.query && !obj.symbol && typeof obj.symbol_ref === "object" && obj.symbol_ref !== null) {
    obj.query = (obj.symbol_ref as Record<string, unknown>).name;
    obj.symbol = obj.query;
  }
  return obj;
}

export const SymbolToolSchema = z.preprocess(
  normalizeSymbolToolArgs,
  z.object({
    action: z.enum(["locate", "inspect", "impact", "hotspots"]).optional().default("locate"),
    query: z.string().optional(),
    symbol: z.string().optional(),
    domain: z.string().optional(),
    symbol_ref: SymbolReferenceSchema.optional(),
    include_dependencies: z.boolean().optional().default(true),
    limit: z.number().int().positive().optional(),
    min_lines: z.number().int().nonnegative().optional(),
    min_nesting: z.number().int().positive().optional(),
    kind: z.string().optional(),
    sort_by: z.enum(["lines", "nesting", "risk_score", "line_count"]).optional(),
    workspace_path: z.string().optional(),
    file_path: z.string().min(1).optional(),
    include_source: z.boolean().optional().default(false),
    source_start_line: z.number().int().positive().optional(),
    source_line_limit: z.number().int().positive().max(200).optional().default(120),
  }).superRefine((args, ctx) => {
    if (args.symbol_ref && args.action !== "locate" && args.action !== "inspect" && args.action !== "impact") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["symbol_ref"], message: "symbol_ref is supported only for locate, inspect, and impact." });
    }
  })
);
export type SymbolToolArgs = z.infer<typeof SymbolToolSchema>;

// 3. septum_slice
export const SliceToolSchema = TraceVerticalSliceSchema;
export type SliceToolArgs = TraceVerticalSliceArgs;

// 4. septum_boundary
export const BoundaryToolSchema = CheckBoundarySchema;
export type BoundaryToolArgs = CheckBoundaryArgs;

// 5. septum_feature
export function normalizeFeatureToolArgs(raw: unknown): unknown {
  const coerced = extractSingleStringFallback(raw, "feature_key", [
    "workspace_path",
    "workspacePath",
    "workspace",
    "project_root",
    "projectRoot",
    "action",
    "domain",
    "domain_name",
    "domainName",
    "force",
  ]);
  if (typeof coerced !== "object" || coerced === null || Array.isArray(coerced)) return coerced;
  const obj = { ...(coerced as Record<string, unknown>) };

  const aliases: Record<string, string> = {
    feature: "feature_key",
    featureKey: "feature_key",
    feature_name: "feature_key",
    featureName: "feature_key",
    feat: "feature_key",
    name: "feature_key",
    key: "feature_key",
    domain_name: "domain",
    domainName: "domain",
    touchpoints: "allowed_touchpoints",
    allowedTouchpoints: "allowed_touchpoints",
    touchpoint: "allowed_touchpoints",
    files: "allowed_touchpoints",
    allowed_files: "allowed_touchpoints",
    reuseSymbols: "reuse_symbols",
    reuse: "reuse_symbols",
    symbols: "reuse_symbols",
    inputContract: "input_contract",
    outputContract: "output_contract",
    workspace: "workspace_path",
    workspacePath: "workspace_path",
    project_root: "workspace_path",
    projectRoot: "workspace_path",
  };

  for (const [alias, target] of Object.entries(aliases)) {
    if (obj[alias] !== undefined && obj[target] === undefined) {
      obj[target] = obj[alias];
    }
  }

  if (obj.feature_key !== undefined && obj.feature === undefined) {
    obj.feature = obj.feature_key;
  } else if (obj.feature !== undefined && obj.feature_key === undefined) {
    obj.feature_key = obj.feature;
  }

  if (obj.domain !== undefined && obj.domain_name === undefined) {
    obj.domain_name = obj.domain;
  } else if (obj.domain_name !== undefined && obj.domain === undefined) {
    obj.domain = obj.domain_name;
  }

  if (typeof obj.allowed_touchpoints === "string") {
    obj.allowed_touchpoints = [obj.allowed_touchpoints];
  } else if (!Array.isArray(obj.allowed_touchpoints) && obj.allowed_touchpoints !== undefined) {
    obj.allowed_touchpoints = [];
  }

  if (typeof obj.reuse_symbols === "string") {
    obj.reuse_symbols = [obj.reuse_symbols];
  }

  if (!obj.action) {
    if (obj.allowed_touchpoints !== undefined || obj.domain !== undefined || obj.reuse_symbols !== undefined) {
      obj.action = "lock";
    } else {
      obj.action = "get";
    }
  }

  return obj;
}

export const FeatureToolSchema = z.preprocess(
  normalizeFeatureToolArgs,
  z.object({
    action: z.enum(["get", "lock", "release"]).optional().default("get"),
    feature_key: z.string().optional(),
    feature: z.string().optional(),
    domain: z.string().optional(),
    domain_name: z.string().optional(),
    description: z.string().optional(),
    allowed_touchpoints: z.array(z.string()).optional(),
    reuse_symbols: z.array(z.string()).optional(),
    input_contract: z.record(z.unknown()).optional(),
    output_contract: z.record(z.unknown()).optional(),
    force: z.boolean().optional().default(false),
    workspace_path: z.string().optional(),
  })
);
export type FeatureToolArgs = z.infer<typeof FeatureToolSchema>;

