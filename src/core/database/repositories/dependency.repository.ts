import * as fs from "node:fs";
import type { Database } from "bun:sqlite";
import type {
  ExtractedDependency,
  GetSymbolImpactResponse,
  InboundCaller,
  VerticalSliceRecord,
} from "../../../types/index.ts";

export class DependencyRepository {
  constructor(private db: Database) {}

  public replaceFileDependencies(fileId: number, deps: ExtractedDependency[]): void {
    this.db.query("DELETE FROM dependencies WHERE source_file_id = ?").run(fileId);
    if (deps.length === 0) return;

    const stmt = this.db.query(
      `INSERT INTO dependencies (source_file_id, target_symbol_or_path, import_statement, line_number, is_external) 
       VALUES (?, ?, ?, ?, ?)`
    );

    for (const dep of deps) {
      stmt.run(fileId, dep.target, dep.statement, dep.line_number, dep.is_external ? 1 : 0);
    }
  }

  public upsertVerticalSlice(
    slice: Omit<VerticalSliceRecord, "id" | "created_at">
  ): void {
    const existing = this.db
      .query<VerticalSliceRecord, [string, string]>(
        "SELECT id FROM vertical_slices WHERE http_method = ? AND route_uri = ?"
      )
      .get(slice.http_method, slice.route_uri);

    if (existing) {
      this.db
        .query(
          `UPDATE vertical_slices
           SET domain_id = ?, feature_key = ?, route_name = ?, controller_class = ?,
               action_name = ?, controller_file = ?, controller_line = ?,
               architecture_style = ?, entry_kind = ?, execution_chain_json = ?
           WHERE id = ?`
        )
        .run(
          slice.domain_id,
          slice.feature_key,
          slice.route_name,
          slice.controller_class,
          slice.action_name,
          slice.controller_file,
          slice.controller_line,
          slice.architecture_style ?? "clean",
          slice.entry_kind ?? "http_route",
          slice.execution_chain_json,
          existing.id
        );
    } else {
      this.db
        .query(
          `INSERT INTO vertical_slices (
            domain_id, feature_key, http_method, route_uri, route_name,
            controller_class, action_name, controller_file, controller_line,
            architecture_style, entry_kind, execution_chain_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          slice.domain_id,
          slice.feature_key,
          slice.http_method,
          slice.route_uri,
          slice.route_name,
          slice.controller_class,
          slice.action_name,
          slice.controller_file,
          slice.controller_line,
          slice.architecture_style ?? "clean",
          slice.entry_kind ?? "http_route",
          slice.execution_chain_json
        );
    }
  }

  public findVerticalSlices(searchTerm: string): VerticalSliceRecord[] {
    const term = searchTerm.trim();
    const wild = `%${term}%`;
    const query = `
      SELECT * FROM vertical_slices
      WHERE route_uri LIKE ?
         OR route_name LIKE ?
         OR controller_class LIKE ?
         OR action_name LIKE ?
         OR feature_key LIKE ?
         OR execution_chain_json LIKE ?
      ORDER BY id ASC
    `;
    return this.db.query<VerticalSliceRecord, [string, string, string, string, string, string]>(query).all(
      wild, wild, wild, wild, wild, wild
    );
  }

  public getAllVerticalSlices(): VerticalSliceRecord[] {
    return this.db.query<VerticalSliceRecord, []>("SELECT * FROM vertical_slices ORDER BY id ASC").all();
  }

  public clearVerticalSlices(domainId?: number): void {
    if (domainId) {
      this.db.query("DELETE FROM vertical_slices WHERE domain_id = ?").run(domainId);
    } else {
      this.db.query("DELETE FROM vertical_slices").run();
    }
  }

  public getAllDependenciesWithDomains(): Array<{
    source_file: string;
    source_domain: string;
    line_number: number;
    target: string;
    statement: string;
    is_external: boolean;
  }> {
    const query = `
      SELECT 
        f.path AS source_file,
        d.name AS source_domain,
        dep.line_number,
        dep.target_symbol_or_path AS target,
        dep.import_statement AS statement,
        dep.is_external
      FROM dependencies dep
      JOIN files f ON dep.source_file_id = f.id
      JOIN domains d ON f.domain_id = d.id
      ORDER BY d.name, f.path, dep.line_number
    `;
    return this.db.query<any, []>(query).all();
  }

  public getSymbolImpact(symbolQuery: string): GetSymbolImpactResponse {
    const trimmed = symbolQuery.trim();
    if (!trimmed) {
      return {
        target_symbol: symbolQuery,
        impact_summary: {
          total_dependents: 0,
          risk_level: "low",
          affected_files_count: 0,
        },
        inbound_callers: [],
      };
    }

    let targetContainer = trimmed;
    let targetMethod = "";
    if (trimmed.includes("::")) {
      const parts = trimmed.split("::");
      targetContainer = parts[0];
      targetMethod = parts[1];
    } else if (trimmed.includes("@")) {
      const parts = trimmed.split("@");
      targetContainer = parts[0];
      targetMethod = parts[1];
    }

    // 1. Inbound dependencies from dependencies table
    const depSql = `
      SELECT 
        f.path AS file,
        d.line_number,
        d.target_symbol_or_path,
        dom.name AS domain_name
      FROM dependencies d
      JOIN files f ON d.source_file_id = f.id
      JOIN domains dom ON f.domain_id = dom.id
      WHERE d.target_symbol_or_path LIKE ?
         OR d.target_symbol_or_path LIKE ?
      ORDER BY f.path ASC, d.line_number ASC
    `;
    const depRows = this.db
      .query<any, [string, string]>(depSql)
      .all(`%${targetContainer}%`, `%${trimmed}%`);

    const callersMap = new Map<string, InboundCaller>();

    for (const row of depRows) {
      // Find enclosing symbol in caller file if any
      const enclosing = this.db
        .query<{ name: string; kind: string }, [string, number]>(
          `SELECT s.name, s.kind 
           FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE f.path = ? AND ? BETWEEN s.line_start AND s.line_end
           ORDER BY (s.line_end - s.line_start) ASC LIMIT 1`
        )
        .get(row.file, row.line_number);

      const callerName = enclosing ? enclosing.name : `${row.file}:${row.line_number}`;
      const key = `${row.file}:${row.line_number}:${callerName}`;

      if (!callersMap.has(key)) {
        callersMap.set(key, {
          file: row.file,
          caller: callerName,
          line: row.line_number,
          kind: enclosing?.kind || "import",
          domain: row.domain_name,
        });
      }
    }

    // 2. Scan file content of callers or related files for exact method calls if targetMethod specified
    if (targetMethod) {
      // Look for files importing targetContainer and inspect if they call targetMethod
      const uniqueFiles = Array.from(new Set(depRows.map((r) => r.file)));
      for (const filePath of uniqueFiles) {
        try {
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (
                line.includes(`->${targetMethod}(`) ||
                line.includes(`::${targetMethod}(`)
              ) {
                const lineNum = i + 1;
                const enclosing = this.db
                  .query<{ name: string; kind: string }, [string, number]>(
                    `SELECT s.name, s.kind 
                     FROM symbols s
                     JOIN files f ON s.file_id = f.id
                     WHERE f.path = ? AND ? BETWEEN s.line_start AND s.line_end
                     ORDER BY (s.line_end - s.line_start) ASC LIMIT 1`
                  )
                  .get(filePath, lineNum);

                const callerName = enclosing ? enclosing.name : `${filePath}:${lineNum}`;
                const key = `${filePath}:${lineNum}:${callerName}`;
                if (!callersMap.has(key)) {
                  callersMap.set(key, {
                    file: filePath,
                    caller: callerName,
                    line: lineNum,
                    kind: enclosing?.kind || "call",
                  });
                }
              }
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    const inboundCallers = Array.from(callersMap.values());
    const affectedFiles = new Set(inboundCallers.map((c) => c.file));
    const distinctDomains = new Set(
      inboundCallers.map((c) => c.domain).filter(Boolean)
    );

    let riskLevel: "low" | "medium" | "high" = "low";
    if (affectedFiles.size > 5 || distinctDomains.size > 2) {
      riskLevel = "high";
    } else if (affectedFiles.size >= 2 || distinctDomains.size >= 2) {
      riskLevel = "medium";
    }

    return {
      target_symbol: trimmed,
      impact_summary: {
        total_dependents: inboundCallers.length,
        risk_level: riskLevel,
        affected_files_count: affectedFiles.size,
      },
      inbound_callers: inboundCallers,
    };
  }

}
