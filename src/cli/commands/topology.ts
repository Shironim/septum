import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { EnvironmentDetector } from "../../core/topology/environment-detector.ts";
import type { EnvironmentLayer, TopologyNode } from "../../core/topology/types.ts";

export async function handleTopologyCommand(
  subcommand?: string,
  arg1?: string,
  arg2?: string,
  arg3?: string,
  arg4?: string
): Promise<void> {
  const cwd = process.cwd();
  const db = new SeptumDatabase();
  const repo = new SeptumRepository(db.raw);

  if (subcommand === "resolve" && arg1 && arg2) {
    const layer = arg1.toLowerCase() as EnvironmentLayer;
    const platform = arg2;
    // Fix: Preserve existing constraints instead of overwriting with empty array
    const existing = repo.environment.getLayer(layer);
    repo.environment.saveLayer({
      layer,
      platform,
      canonical_tag: EnvironmentDetector.matchCanonicalTag(platform),
      status: "VERIFIED",
      detected_from: ["CLI Manual Resolution"],
      constraints: existing?.constraints && existing.constraints.length > 0 ? existing.constraints : [
        `Configured manually as '${platform}'.`
      ],
    });
    console.log(`[Septum Topology] Layer '${layer}' successfully verified as '${platform}' in SQLite SSOT.\n`);
  } else if (subcommand === "add-node" && arg1 && arg2 && arg3) {
    const nodeId = arg1;
    const layer = arg2.toLowerCase() as EnvironmentLayer;
    const platform = arg3;
    const domainOrIp = arg4;

    const node: TopologyNode = {
      id: nodeId,
      layer,
      name: nodeId,
      platform,
      canonical_tag: EnvironmentDetector.matchCanonicalTag(platform),
      domain_or_ip: domainOrIp,
      status: "VERIFIED",
      detected_from: ["CLI Manual Node Resolution"],
      constraints: [`Node added manually with platform '${platform}'.`],
    };
    repo.environment.saveNode(node);
    console.log(`[Septum Topology] Node '${nodeId}' (${layer.toUpperCase()}) added to distributed topology graph.\n`);
  } else if (subcommand === "remove-node" && arg1) {
    repo.environment.deleteNode(arg1);
    console.log(`[Septum Topology] Node '${arg1}' removed from distributed topology graph.\n`);
  } else if (subcommand === "clear") {
    repo.environment.clearAll();
    console.log("[Septum Topology] Cleared environment topology and nodes in SQLite SSOT.\n");
  }

  const topology = EnvironmentDetector.detect(cwd, repo);

  console.log("================================================================================");
  console.log("🌐 SEPTUM SELF-AWARE ENVIRONMENT TOPOLOGY PLANE");
  console.log("================================================================================");
  console.log(`Overall Status:   ${topology.overall_status}`);
  console.log(`Topology Mode:    ${topology.is_distributed ? "DISTRIBUTED MULTI-NODE GRAPH" : "MONOLITHIC SINGLE-NODE"}`);
  console.log(`Summary:          ${topology.architectural_summary}\n`);

  if (topology.nodes.length > 0) {
    console.log("--- DISTRIBUTED TOPOLOGY NODES ---");
    for (const node of topology.nodes) {
      const statusIcon = node.status === "VERIFIED" ? "✓ [VERIFIED]" : node.status === "DETECTED" ? "• [DETECTED]" : "? [AMBIGUOUS]";
      const domainStr = node.domain_or_ip ? ` @ ${node.domain_or_ip}` : "";
      const roleStr = node.role ? ` [Role: ${node.role}]` : "";
      console.log(`  ${statusIcon} ${node.id.padEnd(20)} (${node.layer.toUpperCase()}): ${node.platform}${domainStr}${roleStr}`);
      if (node.connected_to && node.connected_to.length > 0) {
        console.log(`      ➔ Connected to: ${node.connected_to.join(", ")}`);
      }
      if (node.constraints && node.constraints.length > 0) {
        for (const c of node.constraints) {
          console.log(`      - ${c}`);
        }
      }
    }
    console.log("");
  }

  console.log("--- 6-LAYER PRODUCTION SUMMARY PLANE ---");
  for (const [layerKey, info] of Object.entries(topology.layers)) {
    const statusIcon = info.status === "VERIFIED" ? "✓ [VERIFIED]" : info.status === "DETECTED" ? "• [DETECTED]" : "? [AMBIGUOUS]";
    console.log(`  ${statusIcon} ${layerKey.toUpperCase().padEnd(10)}: ${info.platform || "Unresolved"}`);
  }

  if (topology.interplays.length > 0) {
    console.log("\n--- CROSS-LAYER & DISTRIBUTED INVARIANTS ---");
    for (const interplay of topology.interplays) {
      console.log(`  ⚡ ${interplay.title} (${interplay.involved_layers.join(" ➔ ")})`);
      console.log(`     Rule:   ${interplay.risk_or_rule}`);
      console.log(`     Action: ${interplay.required_action}`);
    }
  }

  if (topology.pending_inquiries.length > 0) {
    console.log("\n--- PENDING ARCHITECTURAL INQUIRIES ---");
    console.log("Action Required: Please clarify these ambiguous layers/nodes for your AI Agent:\n");
    for (const inquiry of topology.pending_inquiries) {
      console.log(`  ❓ ${inquiry}`);
    }
    console.log("\nTip: To resolve an inquiry or add distributed nodes, run:");
    console.log("  septum topology resolve <layer> \"<Platform Name>\"");
    console.log("  septum topology add-node <id> <layer> \"<Platform Name>\" [domain_or_ip]");
    console.log("Example:");
    console.log("  septum topology add-node host:vps-worker host \"Ubuntu 24.04 (Dedicated Worker)\" 10.0.0.6");
  }

  console.log("================================================================================\n");

  db.close();
}
