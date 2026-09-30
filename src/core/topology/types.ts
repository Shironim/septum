export type EnvironmentLayer =
  | "edge"
  | "gateway"
  | "host"
  | "runtime"
  | "storage"
  | "telemetry";

export type LayerResolutionStatus = "DETECTED" | "AMBIGUOUS" | "UNRESOLVED" | "VERIFIED";

export type CanonicalPlatformTag =
  | "shared_hosting"
  | "vps"
  | "docker"
  | "serverless"
  | "kubernetes"
  | "managed_db"
  | "cdn_edge"
  | "paas"
  | "static_cdn"
  | "unspecified";

export interface EnvironmentLayerInfo {
  layer: EnvironmentLayer;
  platform?: string;
  canonical_tag?: CanonicalPlatformTag;
  status: LayerResolutionStatus;
  detected_from?: string[];
  evidence?: string[];
  constraints?: string[];
  unresolved_inquiry?: string;
}

export interface TopologyNode {
  id: string; // e.g. "edge:cloudflare", "host:api-vps", "host:worker-vps", "storage:central-db"
  layer: EnvironmentLayer;
  name: string; // e.g. "Cloudflare Perimeter", "API Backend VPS", "Postgres Cluster"
  platform: string; // e.g. "Cloudflare WAF", "Hostinger VPS", "AWS RDS Postgres"
  canonical_tag: CanonicalPlatformTag;
  domain_or_ip?: string; // e.g. "api.example.com", "10.0.0.5"
  role?: string; // e.g. "web_api", "queue_worker", "frontend_spa", "database_primary"
  status: LayerResolutionStatus;
  detected_from: string[];
  constraints: string[];
  connected_to?: string[]; // IDs of nodes this node interacts with
  unresolved_inquiry?: string;
}

export interface CrossLayerInterplay {
  title: string;
  involved_layers: EnvironmentLayer[];
  involved_node_ids?: string[];
  risk_or_rule: string;
  required_action: string;
}

export interface EnvironmentTopology {
  is_distributed: boolean;
  nodes: TopologyNode[];
  layers: Record<EnvironmentLayer, EnvironmentLayerInfo>;
  overall_status: "RESOLVED" | "NEEDS_CLARIFICATION";
  interplays: CrossLayerInterplay[];
  pending_inquiries: string[];
  architectural_summary: string;
}

export interface ResolveLayerInput {
  layer: EnvironmentLayer;
  platform: string;
  constraints?: string[];
}

export interface ResolveNodeInput {
  id: string;
  layer: EnvironmentLayer;
  name: string;
  platform: string;
  canonical_tag?: CanonicalPlatformTag;
  domain_or_ip?: string;
  role?: string;
  constraints?: string[];
  connected_to?: string[];
}
