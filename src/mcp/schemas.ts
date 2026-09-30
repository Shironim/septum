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

function normalizeBoundaryArgs(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  const aliases: Record<string, string> = {
    filePath: "file_path",
    file: "file_path",
    path: "file_path",
    filePaths: "file_paths",
    files: "file_paths",
    paths: "file_paths",
    proposedImports: "proposed_imports",
    imports: "proposed_imports",
    featureKey: "feature_key",
    feature: "feature_key",
  };
  for (const [alias, target] of Object.entries(aliases)) {
    if (obj[alias] !== undefined && obj[target] === undefined) {
      obj[target] = obj[alias];
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
  return obj;
}

export const GetDomainCatalogSchema = z.preprocess(
  (args) =>
    withAliases(args, {
      domain_name: "domain",
      domainName: "domain",
      name: "domain",
      archetype_filter: "archetype",
      archetypeFilter: "archetype",
      type: "archetype",
      workspace: "workspace_path",
      workspacePath: "workspace_path",
      project_root: "workspace_path",
      target_path: "workspace_path",
      path: "workspace_path",
    }),
  z.object({
    domain: z.string().optional(),
    archetype: z.string().optional(),
    workspace_path: z.string().optional(),
  })
);
export type GetDomainCatalogArgs = z.infer<typeof GetDomainCatalogSchema>;

export const GetFeatureContextSchema = z.preprocess(
  (args) =>
    withAliases(args, {
      feature_key: "feature",
      featureKey: "feature",
      name: "feature",
      workspace: "workspace_path",
      workspacePath: "workspace_path",
    }),
  z.object({
    feature: z.string().min(1, "feature is required"),
    workspace_path: z.string().optional(),
  })
);
export type GetFeatureContextArgs = z.infer<typeof GetFeatureContextSchema>;

export const LocateSymbolSchema = z.preprocess(
  (args) =>
    withAliases(args, {
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
      target_path: "workspace_path",
      path: "workspace_path",
    }),
  z.object({
    query: z.string().min(1, "query is required"),
    domain: z.string().optional(),
    limit: z.number().int().positive().optional().default(10),
    workspace_path: z.string().optional(),
  })
);
export type LocateSymbolArgs = z.infer<typeof LocateSymbolSchema>;

export const GetSymbolSchema = z.preprocess(
  (args) =>
    withAliases(args, {
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
    }),
  z.object({
    symbol: z.string().min(1, "symbol is required"),
    domain: z.string().optional(),
    include_dependencies: z.boolean().optional().default(true),
  })
);
export type GetSymbolArgs = z.infer<typeof GetSymbolSchema>;

export const GetSymbolImpactSchema = z.preprocess(
  (args) =>
    withAliases(args, {
      query: "symbol",
      name: "symbol",
      symbol_name: "symbol",
      symbolName: "symbol",
      file_path: "symbol",
      filePath: "symbol",
      file: "symbol",
      path: "symbol",
      target: "symbol",
    }),
  z.object({
    symbol: z.string().min(1, "symbol is required"),
  })
);
export type GetSymbolImpactArgs = z.infer<typeof GetSymbolImpactSchema>;

export const TraceVerticalSliceSchema = z.preprocess(
  (args) =>
    withAliases(args, {
      route: "query",
      uri: "query",
      route_uri: "query",
      routeUri: "query",
      symbol: "query",
      name: "query",
      feature: "query",
      feature_key: "query",
      featureKey: "query",
      maxDepth: "max_depth",
      depth: "max_depth",
    }),
  z.object({
    query: z.string().min(1, "query is required"),
    max_depth: z.number().int().positive().optional().default(5),
  })
);
export type TraceVerticalSliceArgs = z.infer<typeof TraceVerticalSliceSchema>;

export const CheckBoundarySchema = z.preprocess(
  normalizeBoundaryArgs,
  z.object({
    file_path: z.string().optional(),
    file_paths: z.array(z.string()).optional(),
    proposed_imports: z.array(z.string()).default([]),
    feature_key: z.string().optional(),
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
    }),
  z.object({
    min_lines: z.number().int().nonnegative().optional(),
    min_nesting: z.number().int().positive().optional(),
    kind: z.string().optional(),
    domain: z.string().optional(),
    limit: z.number().int().positive().optional().default(10),
    sort_by: z.enum(["lines", "nesting", "risk_score"]).optional(),
  })
);
export type GetSymbolHotspotsArgs = z.infer<typeof GetSymbolHotspotsSchema>;

export const RegisterDomainSchema = z.preprocess(
  (args) =>
    withAliases(args, {
      domain: "name",
      domain_name: "name",
      domainName: "name",
      root_path: "root",
      rootPath: "root",
      path: "root",
      allowedDependencies: "allowed_dependencies",
      allowed: "allowed_dependencies",
      forbiddenDependencies: "forbidden_dependencies",
      forbidden: "forbidden_dependencies",
      archetype: "archetypes",
      ingestNow: "ingest_now",
    }),
  z.object({
    name: z.string().min(1, "Domain name is required"),
    root: z.string().min(1, "Domain root path is required"),
    description: z.string().optional(),
    allowed_dependencies: z.array(z.string()).optional(),
    forbidden_dependencies: z.array(z.string()).optional(),
    archetypes: z.record(z.string()).optional(),
    ingest_now: z.boolean().optional().default(false),
  })
);
export type RegisterDomainArgs = z.infer<typeof RegisterDomainSchema>;

export const AutoDiscoverDomainsSchema = z.preprocess(
  (args) =>
    withAliases(args, {
      save: "persist",
    }),
  z.object({
    persist: z.boolean().optional().default(true),
  })
);
export type AutoDiscoverDomainsArgs = z.infer<typeof AutoDiscoverDomainsSchema>;

export const GetEnvironmentTopologySchema = z.object({
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
});
export type GetEnvironmentTopologyArgs = z.infer<typeof GetEnvironmentTopologySchema>;


