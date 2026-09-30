import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { EnvironmentDetector } from "../../core/topology/environment-detector.ts";
import type { EnvironmentLayer, ResolveLayerInput, ResolveNodeInput } from "../../core/topology/types.ts";

export interface GetEnvironmentTopologyArgs {
  resolve?: ResolveLayerInput;
  resolveNode?: ResolveNodeInput;
  refresh?: boolean;
}

export function handleGetEnvironmentTopology(
  repo: SeptumRepository,
  _config: ValidatedSeptumConfig,
  args: GetEnvironmentTopologyArgs,
  workspaceRoot: string
) {
  // If layer resolution input is provided, persist into SQLite SSOT
  if (args.resolve) {
    const existing = repo.environment.getLayer(args.resolve.layer);
    repo.environment.saveLayer({
      layer: args.resolve.layer,
      platform: args.resolve.platform,
      canonical_tag: EnvironmentDetector.matchCanonicalTag(args.resolve.platform),
      status: "VERIFIED",
      constraints: args.resolve.constraints && args.resolve.constraints.length > 0 ? args.resolve.constraints : (existing?.constraints ?? []),
      detected_from: ["Manual Developer Resolution via Septum"],
    });
  }

  // If node resolution input is provided, persist node into SQLite SSOT
  if (args.resolveNode) {
    repo.environment.saveNode({
      id: args.resolveNode.id,
      layer: args.resolveNode.layer,
      name: args.resolveNode.name,
      platform: args.resolveNode.platform,
      canonical_tag: args.resolveNode.canonical_tag || EnvironmentDetector.matchCanonicalTag(args.resolveNode.platform),
      domain_or_ip: args.resolveNode.domain_or_ip,
      role: args.resolveNode.role,
      status: "VERIFIED",
      detected_from: ["Manual Developer Resolution via Septum MCP"],
      constraints: args.resolveNode.constraints ?? [],
      connected_to: args.resolveNode.connected_to ?? [],
    });
  }

  // Detect current topology merging heuristics with SQLite SSOT
  const topology = EnvironmentDetector.detect(workspaceRoot, repo, args.refresh);

  // Format into high-density Markdown output
  let output = `### 🌐 Septum Environment & Topology Plane\n\n`;
  output += `> **Overall Status:** \`${topology.overall_status}\`\n`;
  output += `> **Topology Mode:** \`${topology.is_distributed ? "DISTRIBUTED MULTI-NODE GRAPH" : "MONOLITHIC SINGLE-NODE"}\`\n`;
  output += `> **Architecture:** ${topology.architectural_summary}\n\n`;

  // Section 1: Distributed Nodes Graph
  if (topology.nodes.length > 0) {
    output += `#### 📦 Distributed Topology Nodes (${topology.nodes.length} entities):\n`;
    output += `| Node ID | Layer | Platform / Specs | Role | Domain / Host | Connected To | Status |\n`;
    output += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    for (const node of topology.nodes) {
      const statusBadge = node.status === "VERIFIED" ? "✅ VERIFIED" : node.status === "DETECTED" ? "🔍 DETECTED" : "⚠️ " + node.status;
      const domain = node.domain_or_ip ? `\`${node.domain_or_ip}\`` : "-";
      const role = node.role ? `\`${node.role}\`` : "-";
      const connected = node.connected_to && node.connected_to.length > 0 ? node.connected_to.join(", ") : "-";
      output += `| **\`${node.id}\`** | ${node.layer.toUpperCase()} | ${node.platform} | ${role} | ${domain} | ${connected} | ${statusBadge} |\n`;
    }
    output += `\n`;
  }

  // Section 2: 6-Layer Summary
  output += `#### 🗺️ 6-Layer Plane Summary:\n`;
  output += `| Layer | Plane Domain | Platform / Setup | Status | Evidence / Files |\n`;
  output += `| :--- | :--- | :--- | :--- | :--- |\n`;

  const layerLabels: Record<EnvironmentLayer, string> = {
    edge: "Perimeter & WAF",
    gateway: "Ingress & Web Server",
    host: "Deployment Platform",
    runtime: "Application Engine",
    storage: "Data & Cache",
    telemetry: "Observability & Logs",
  };

  for (const layerKey of Object.keys(topology.layers) as EnvironmentLayer[]) {
    const info = topology.layers[layerKey];
    const evidence = info.detected_from && info.detected_from.length > 0 ? info.detected_from.join(", ") : "-";
    const statusBadge = info.status === "VERIFIED" ? "✅ VERIFIED" : info.status === "DETECTED" ? "🔍 DETECTED" : "⚠️ " + info.status;
    output += `| **${layerKey.toUpperCase()}** | ${layerLabels[layerKey]} | ${info.platform || "Not Defined"} | ${statusBadge} | ${evidence} |\n`;
  }

  // Section 3: Active Constraints
  output += `\n#### 📌 Active Architectural Constraints:\n`;
  let hasConstraints = false;
  for (const node of topology.nodes) {
    if (node.constraints && node.constraints.length > 0) {
      hasConstraints = true;
      output += `- **\`${node.id}\` (${node.platform}):**\n`;
      for (const c of node.constraints) {
        output += `  • ${c}\n`;
      }
    }
  }
  if (!hasConstraints) {
    output += `*No specific node constraints recorded.*\n`;
  }

  // Section 4: Cross-Layer & Distributed Interplays
  if (topology.interplays.length > 0) {
    output += `\n#### ⚡ Cross-Layer & Distributed Invariants:\n`;
    for (const interplay of topology.interplays) {
      const nodeTrace = interplay.involved_node_ids && interplay.involved_node_ids.length > 0 ? ` (Nodes: \`${interplay.involved_node_ids.join(", ")}\`)` : "";
      output += `- **${interplay.title}** (Layers: \`${interplay.involved_layers.join(" ➔ ")}\`)${nodeTrace}:\n`;
      output += `  • *Invarian:* ${interplay.risk_or_rule}\n`;
      output += `  • *Tindakan Wajib:* ${interplay.required_action}\n`;
    }
  }

  // Section 5: Pending Inquiries
  if (topology.pending_inquiries.length > 0) {
    output += `\n#### ❓ Pending Architectural Inquiries (Self-Aware Inquiry Required):\n`;
    output += `Terdapat layer atau node arsitektural yang belum terkonfirmasi. Sebelum mengeksekusi kode terkait deployment/throttling/cron/cookies, klarifikasikan hal berikut ke pengguna:\n`;
    for (const q of topology.pending_inquiries) {
      output += `- ${q}\n`;
    }
    output += `\n*Untuk mengunci jawaban pengguna ke SQLite SSOT, panggil kembali tool ini dengan argumen:*\n`;
    output += `\`septum_get_environment_topology(resolve: { layer: "<layer_name>", platform: "<platform_name>" })\`\n`;
    output += `*atau untuk entitas terdistribusi:*\n`;
    output += `\`septum_get_environment_topology(resolveNode: { id: "<node_id>", layer: "<layer>", name: "<name>", platform: "<platform>", domain_or_ip: "<domain_or_ip>", role: "<role>" })\`\n`;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
}
