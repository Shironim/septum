export type EnforcementMode = "strict" | "warn";

export type ArchetypeKind =
  | "controller"
  | "service"
  | "model"
  | "repository"
  | "action"
  | "job"
  | "event"
  | "listener"
  | "middleware"
  | "request"
  | "resource"
  | "util"
  | "unknown";

export type SymbolKind =
  | "class"
  | "interface"
  | "trait"
  | "enum"
  | "method"
  | "function"
  | "type"
  | "property";

export type Visibility = "public" | "protected" | "private";

export interface SeptumConfig {
  version: string;
  settings: {
    enforcement: EnforcementMode;
    db_path?: string;
    ignore_patterns?: string[];
  };
  domains: Record<string, DomainConfig>;
  features?: Record<string, FeatureConfig>;
}

export interface DomainConfig {
  root: string;
  allowed_dependencies?: string[];
  forbidden_dependencies?: string[];
  archetypes?: Record<string, string>;
  description?: string;
}

export interface FeatureConfig {
  domain: string;
  description?: string;
  allowed_touchpoints: string[];
  reuse_symbols?: string[];
  input_contract?: Record<string, unknown>;
  output_contract?: Record<string, unknown>;
}

export interface FeatureContextResponse {
  feature: string;
  domain: string;
  description?: string;
  allowed_touchpoints: string[];
  reuse_symbols: Array<{
    name: string;
    kind: string;
    signature?: string;
    methods?: string[];
    properties?: string[];
    file_path?: string;
    domain?: string;
  }>;
  input_contract: Record<string, unknown>;
  output_contract: Record<string, unknown>;
  governance_directives?: string[];
}

export interface CheckBoundaryArgs {
  file_path: string;
  proposed_imports: string[];
  feature_key?: string;
}

export interface DomainRecord {
  id: number;
  name: string;
  root_path: string;
  allowed_deps_json: string;
  forbidden_deps_json: string;
  archetypes_json: string;
  created_at: string;
  updated_at: string;
}

export interface FileRecord {
  id: number;
  domain_id: number;
  path: string;
  archetype: ArchetypeKind;
  content_hash: string;
  line_count: number;
  mtime_ms: number;
  size_bytes: number;
  last_scanned_at: string;
}

export interface ActiveFeatureSession {
  feature_key: string;
  domain: string;
  touchpoints: string[];
  locked_at: string;
}

export interface SymbolRecord {
  id: number;
  file_id: number;
  name: string;
  kind: SymbolKind;
  signature: string;
  visibility: Visibility;
  line_start: number;
  line_end: number;
  line_count: number;
}

export interface DependencyRecord {
  id: number;
  source_file_id: number;
  target_symbol_or_path: string;
  import_statement: string;
  line_number: number;
  is_external: boolean;
}

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  signature: string;
  visibility: Visibility;
  line_start: number;
  line_end: number;
  line_count: number;
}

export interface ExtractedDependency {
  target: string;
  statement: string;
  line_number: number;
  is_external: boolean;
}

export interface ParsedFileAST {
  symbols: ExtractedSymbol[];
  dependencies: ExtractedDependency[];
}

export type BoundaryViolationRule =
  | "forbidden_dependency"
  | "disallowed_dependency"
  | "touchpoint_violation"
  | "unknown_feature";

export interface BoundaryViolation {
  file: string;
  line: number;
  source_domain: string;
  target_domain: string;
  imported_target: string;
  rule: BoundaryViolationRule;
  message: string;
}

export interface DomainCatalogResponse {
  domain: string;
  root: string;
  allowed_dependencies: string[];
  forbidden_dependencies: string[];
  files: Array<{
    path: string;
    archetype: ArchetypeKind;
    symbols: Array<{
      name: string;
      kind: SymbolKind;
      properties?: string[];
      methods?: string[];
      signatures?: string[];
    }>;
  }>;
}

export interface ExecutionChainNode {
  stage:
    | "ingress"
    | "validation"
    | "controller"
    | "orchestrator"
    | "use_case"
    | "domain"
    | "entity"
    | "egress"
    | "repository"
    | string;
  symbol: string;
  file?: string;
  line?: number;
  description?: string;
}

export interface VerticalSliceRecord {
  id: number;
  domain_id: number | null;
  feature_key: string | null;
  http_method: string;
  route_uri: string;
  route_name: string | null;
  controller_class: string;
  action_name: string;
  controller_file: string | null;
  controller_line: number;
  architecture_style: string;
  entry_kind: string;
  execution_chain_json: string;
  created_at: string;
}

export interface VerticalSliceTraceResponse {
  query: string;
  found: boolean;
  confidence?: "exact" | "inferred";
  is_exact_match?: boolean;
  architecture_style?: string;
  entrypoint?: {
    method: string;
    uri: string;
    name?: string | null;
    controller: string;
    action: string;
    file?: string | null;
    line?: number;
  };
  chain?: ExecutionChainNode[];
  alternatives?: Array<{
    method: string;
    uri: string;
    controller: string;
    action: string;
  }>;
  message: string;
}

export interface GetSymbolArgs {
  symbol: string;
  domain?: string;
  include_dependencies?: boolean;
}

export interface SymbolExactRange {
  start_line: number;
  end_line: number;
  total_lines: number;
}

export interface GetSymbolDetailsResponse {
  symbol: string;
  kind: SymbolKind | string;
  file_path: string;
  domain?: string;
  exact_range: SymbolExactRange;
  signature: string;
  visibility?: Visibility | string;
  dependencies_injected: string[];
  outbound_calls: string[];
  sibling_methods?: string[];
}

export interface GetSymbolImpactArgs {
  symbol: string;
}

export interface InboundCaller {
  file: string;
  caller: string;
  line: number;
  kind?: string;
  domain?: string;
}

export interface GetSymbolImpactResponse {
  target_symbol: string;
  impact_summary: {
    total_dependents: number;
    risk_level: "low" | "medium" | "high";
    affected_files_count: number;
  };
  inbound_callers: InboundCaller[];
}

