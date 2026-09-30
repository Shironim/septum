import type { Database } from "bun:sqlite";
import type { CanonicalPlatformTag, EnvironmentLayer, EnvironmentLayerInfo, TopologyNode } from "../../topology/types.ts";

export class EnvironmentRepository {
  constructor(private db: Database) {}

  public getLayer(layer: EnvironmentLayer): EnvironmentLayerInfo | null {
    const row = this.db
      .query<{
        layer: string;
        platform: string | null;
        status: string;
        detected_from_json: string;
        constraints_json: string;
        unresolved_inquiry: string | null;
      }, [string]>("SELECT * FROM environment_topology WHERE layer = ?")
      .get(layer);

    if (!row) return null;
    return {
      layer: row.layer as EnvironmentLayer,
      platform: row.platform ?? undefined,
      status: row.status as any,
      detected_from: JSON.parse(row.detected_from_json || "[]"),
      constraints: JSON.parse(row.constraints_json || "[]"),
      unresolved_inquiry: row.unresolved_inquiry ?? undefined,
    };
  }

  public getAllLayers(): Record<EnvironmentLayer, EnvironmentLayerInfo> {
    const rows = this.db
      .query<{
        layer: string;
        platform: string | null;
        status: string;
        detected_from_json: string;
        constraints_json: string;
        unresolved_inquiry: string | null;
      }, []>("SELECT * FROM environment_topology")
      .all();

    const result: Partial<Record<EnvironmentLayer, EnvironmentLayerInfo>> = {};
    for (const row of rows) {
      result[row.layer as EnvironmentLayer] = {
        layer: row.layer as EnvironmentLayer,
        platform: row.platform ?? undefined,
        status: row.status as any,
        detected_from: JSON.parse(row.detected_from_json || "[]"),
        constraints: JSON.parse(row.constraints_json || "[]"),
        unresolved_inquiry: row.unresolved_inquiry ?? undefined,
      };
    }
    return result as Record<EnvironmentLayer, EnvironmentLayerInfo>;
  }

  public saveLayer(info: EnvironmentLayerInfo): void {
    this.db
      .query(
        `INSERT INTO environment_topology (
          layer, platform, status, detected_from_json, constraints_json, unresolved_inquiry, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(layer) DO UPDATE SET
          platform = excluded.platform,
          status = excluded.status,
          detected_from_json = excluded.detected_from_json,
          constraints_json = excluded.constraints_json,
          unresolved_inquiry = excluded.unresolved_inquiry,
          updated_at = CURRENT_TIMESTAMP`
      )
      .run(
        info.layer,
        info.platform ?? null,
        info.status,
        JSON.stringify(info.detected_from ?? []),
        JSON.stringify(info.constraints ?? []),
        info.unresolved_inquiry ?? null
      );
  }

  public clearAll(): void {
    this.db.run("DELETE FROM environment_topology");
    this.db.run("DELETE FROM environment_nodes");
  }

  // Node CRUD operations for Multi-Node Topology
  public getNode(id: string): TopologyNode | null {
    const row = this.db
      .query<{
        id: string;
        layer: string;
        name: string;
        platform: string;
        canonical_tag: string;
        domain_or_ip: string | null;
        role: string | null;
        status: string;
        detected_from_json: string;
        constraints_json: string;
        connected_to_json: string;
        unresolved_inquiry: string | null;
      }, [string]>("SELECT * FROM environment_nodes WHERE id = ?")
      .get(id);

    if (!row) return null;
    return this.mapNodeRow(row);
  }

  public getAllNodes(): TopologyNode[] {
    const rows = this.db
      .query<{
        id: string;
        layer: string;
        name: string;
        platform: string;
        canonical_tag: string;
        domain_or_ip: string | null;
        role: string | null;
        status: string;
        detected_from_json: string;
        constraints_json: string;
        connected_to_json: string;
        unresolved_inquiry: string | null;
      }, []>("SELECT * FROM environment_nodes ORDER BY layer, id")
      .all();

    return rows.map((r) => this.mapNodeRow(r));
  }

  public getNodesByLayer(layer: EnvironmentLayer): TopologyNode[] {
    const rows = this.db
      .query<{
        id: string;
        layer: string;
        name: string;
        platform: string;
        canonical_tag: string;
        domain_or_ip: string | null;
        role: string | null;
        status: string;
        detected_from_json: string;
        constraints_json: string;
        connected_to_json: string;
        unresolved_inquiry: string | null;
      }, [string]>("SELECT * FROM environment_nodes WHERE layer = ? ORDER BY id")
      .all(layer);

    return rows.map((r) => this.mapNodeRow(r));
  }

  public saveNode(node: TopologyNode): void {
    this.db
      .query(
        `INSERT INTO environment_nodes (
          id, layer, name, platform, canonical_tag, domain_or_ip, role, status,
          detected_from_json, constraints_json, connected_to_json, unresolved_inquiry, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          layer = excluded.layer,
          name = excluded.name,
          platform = excluded.platform,
          canonical_tag = excluded.canonical_tag,
          domain_or_ip = excluded.domain_or_ip,
          role = excluded.role,
          status = excluded.status,
          detected_from_json = excluded.detected_from_json,
          constraints_json = excluded.constraints_json,
          connected_to_json = excluded.connected_to_json,
          unresolved_inquiry = excluded.unresolved_inquiry,
          updated_at = CURRENT_TIMESTAMP`
      )
      .run(
        node.id,
        node.layer,
        node.name,
        node.platform,
        node.canonical_tag || "unspecified",
        node.domain_or_ip ?? null,
        node.role ?? null,
        node.status,
        JSON.stringify(node.detected_from ?? []),
        JSON.stringify(node.constraints ?? []),
        JSON.stringify(node.connected_to ?? []),
        node.unresolved_inquiry ?? null
      );
  }

  public deleteNode(id: string): void {
    this.db.query("DELETE FROM environment_nodes WHERE id = ?").run(id);
  }

  private mapNodeRow(row: any): TopologyNode {
    return {
      id: row.id,
      layer: row.layer as EnvironmentLayer,
      name: row.name,
      platform: row.platform,
      canonical_tag: (row.canonical_tag as CanonicalPlatformTag) || "unspecified",
      domain_or_ip: row.domain_or_ip ?? undefined,
      role: row.role ?? undefined,
      status: row.status as any,
      detected_from: JSON.parse(row.detected_from_json || "[]"),
      constraints: JSON.parse(row.constraints_json || "[]"),
      connected_to: JSON.parse(row.connected_to_json || "[]"),
      unresolved_inquiry: row.unresolved_inquiry ?? undefined,
    };
  }
}
