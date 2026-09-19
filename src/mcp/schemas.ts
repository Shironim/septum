import { z } from "zod";

export const GetDomainCatalogSchema = z.object({
  domain: z.string().optional(),
  archetype: z.string().optional(),
});
export type GetDomainCatalogArgs = z.infer<typeof GetDomainCatalogSchema>;

export const GetFeatureContextSchema = z.object({
  feature: z.string().min(1, "feature is required"),
});
export type GetFeatureContextArgs = z.infer<typeof GetFeatureContextSchema>;

export const LocateSymbolSchema = z.object({
  query: z.string().min(1, "query is required"),
  domain: z.string().optional(),
  limit: z.number().int().positive().optional().default(10),
});
export type LocateSymbolArgs = z.infer<typeof LocateSymbolSchema>;

export const GetSymbolSchema = z.object({
  symbol: z.string().min(1, "symbol is required"),
  domain: z.string().optional(),
  include_dependencies: z.boolean().optional().default(true),
});
export type GetSymbolArgs = z.infer<typeof GetSymbolSchema>;

export const GetSymbolImpactSchema = z.object({
  symbol: z.string().min(1, "symbol is required"),
});
export type GetSymbolImpactArgs = z.infer<typeof GetSymbolImpactSchema>;

export const TraceVerticalSliceSchema = z.object({
  query: z.string().min(1, "query is required"),
  max_depth: z.number().int().positive().optional().default(5),
});
export type TraceVerticalSliceArgs = z.infer<typeof TraceVerticalSliceSchema>;

export const CheckBoundarySchema = z.object({
  file_path: z.string().optional(),
  file_paths: z.array(z.string()).optional(),
  proposed_imports: z.array(z.string()).default([]),
  feature_key: z.string().optional(),
});
export type CheckBoundaryArgs = z.infer<typeof CheckBoundarySchema>;

export const GetSymbolHotspotsSchema = z.object({
  domain: z.string().optional(),
  limit: z.number().int().positive().optional().default(10),
});
export type GetSymbolHotspotsArgs = z.infer<typeof GetSymbolHotspotsSchema>;

export const RegisterDomainSchema = z.object({
  name: z.string().min(1, "Domain name is required"),
  root: z.string().min(1, "Domain root path is required"),
  description: z.string().optional(),
  allowed_dependencies: z.array(z.string()).optional(),
  forbidden_dependencies: z.array(z.string()).optional(),
  archetypes: z.record(z.string()).optional(),
  ingest_now: z.boolean().optional().default(false),
});
export type RegisterDomainArgs = z.infer<typeof RegisterDomainSchema>;

export const AutoDiscoverDomainsSchema = z.object({
  persist: z.boolean().optional().default(true),
});
export type AutoDiscoverDomainsArgs = z.infer<typeof AutoDiscoverDomainsSchema>;

