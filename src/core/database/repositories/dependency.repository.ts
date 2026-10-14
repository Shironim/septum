import * as fs from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type {
  ExtractedDependency,
  FileConnectionsSummary,
  GetSymbolImpactResponse,
  InboundCaller,
  VerticalSliceRecord,
} from "../../../types/index.ts";

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

  public countVerticalSlices(): number {
    const row = this.db
      .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM vertical_slices")
      .get();
    return row?.cnt ?? 0;
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

  public getDomainFileConnections(domainId?: number): Map<string, FileConnectionsSummary> {
    const allFiles = this.db
      .query<{ id: number; domain_id: number; path: string }, []>(
        "SELECT id, domain_id, path FROM files ORDER BY path ASC"
      )
      .all();

    const fileById = new Map<number, { id: number; domain_id: number; path: string }>();
    const fileByNormPath = new Map<string, string>();
    const fileByNoExtPath = new Map<string, string>();

    for (const f of allFiles) {
      const norm = f.path.replace(/\\/g, "/").replace(/^\.\//, "");
      fileById.set(f.id, { ...f, path: norm });
      fileByNormPath.set(norm.toLowerCase(), f.path);
      const noExt = norm.replace(/\.[^/.]+$/, "").toLowerCase();
      fileByNoExtPath.set(noExt, f.path);
      if (noExt.endsWith("/index")) {
        fileByNoExtPath.set(noExt.slice(0, -"/index".length), f.path);
      }
    }

    const resolveInternalTarget = (sourcePath: string, rawTarget: string): string | null => {
      const cleaned = rawTarget.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
      if (!cleaned) return null;

      if (cleaned.startsWith(".")) {
        const srcDir = posix.dirname(sourcePath.replace(/\\/g, "/"));
        const joined = posix.normalize(posix.join(srcDir, cleaned)).replace(/^\.\//, "");
        const lowerJoined = joined.toLowerCase();
        const exact = fileByNormPath.get(lowerJoined) ?? fileByNoExtPath.get(lowerJoined.replace(/\.[^/.]+$/, ""));
        if (exact) return exact;
      }

      const aliasClean = cleaned.replace(/^@\//, "src/").replace(/^\.\//, "");
      const lowerAlias = aliasClean.toLowerCase();
      const byAlias = fileByNormPath.get(lowerAlias) ?? fileByNoExtPath.get(lowerAlias.replace(/\.[^/.]+$/, ""));
      if (byAlias) return byAlias;

      for (const [noExt, origPath] of fileByNoExtPath.entries()) {
        if (noExt.endsWith(`/${lowerAlias}`)) {
          return origPath;
        }
      }
      return null;
    };

    const importsFromMap = new Map<string, Set<string>>();
    const importedByMap = new Map<string, Set<string>>();
    for (const f of allFiles) {
      importsFromMap.set(f.path, new Set());
      importedByMap.set(f.path, new Set());
    }

    const allInternalDeps = this.db
      .query<{ source_file_id: number; target_symbol_or_path: string }, []>(
        "SELECT source_file_id, target_symbol_or_path FROM dependencies WHERE is_external = 0"
      )
      .all();

    for (const dep of allInternalDeps) {
      const srcFile = fileById.get(dep.source_file_id);
      if (!srcFile) continue;
      const resolvedTarget = resolveInternalTarget(srcFile.path, dep.target_symbol_or_path);
      if (resolvedTarget && resolvedTarget !== srcFile.path) {
        importsFromMap.get(srcFile.path)?.add(resolvedTarget);
        if (!importedByMap.has(resolvedTarget)) {
          importedByMap.set(resolvedTarget, new Set());
        }
        importedByMap.get(resolvedTarget)?.add(srcFile.path);
      }
    }

    const result = new Map<string, FileConnectionsSummary>();
    for (const f of allFiles) {
      if (domainId !== undefined && f.domain_id !== domainId) continue;
      const importsFrom = Array.from(importsFromMap.get(f.path) ?? []).sort();
      const importedBy = Array.from(importedByMap.get(f.path) ?? []).sort();
      result.set(f.path, {
        imports_from: importsFrom,
        imported_by_count: importedBy.length,
        imported_by: importedBy,
      });
    }

    return result;
  }

  public getFileConnections(filePath: string): FileConnectionsSummary {
    const clean = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const allConns = this.getDomainFileConnections();
    return (
      allConns.get(clean) ??
      allConns.get(filePath) ?? {
        imports_from: [],
        imported_by_count: 0,
        imported_by: [],
      }
    );
  }

  public getSymbolImpact(
    symbolQuery: string,
    options: { domain?: string; workspaceRoot?: string } = {}
  ): GetSymbolImpactResponse {
    const trimmed = symbolQuery.trim();
    if (!trimmed) {
      return {
        target_symbol: symbolQuery,
        found_in_index: false,
        warning: "Empty symbol query provided.",
        impact_summary: {
          total_dependents: 0,
          risk_level: "unknown",
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

    // 1. Look up target symbol in symbols joined with files and optionally domains
    let targetSymRows: Array<{ name: string; file_path: string }>;
    if (targetMethod) {
      let methodSql = `
        SELECT s.name, s.signature, f.path AS file_path
        FROM symbols s
        JOIN files f ON s.file_id = f.id
      `;
      const methodParams: any[] = [];
      if (options.domain) {
        methodSql += ` JOIN domains dom ON f.domain_id = dom.id WHERE LOWER(dom.name) = LOWER(?) AND `;
        methodParams.push(options.domain);
      } else {
        methodSql += ` WHERE `;
      }
      methodSql += ` (s.name = ? OR s.name = ? OR (s.name = ? AND s.kind = 'method')) `;
      methodParams.push(trimmed, `${targetContainer}::${targetMethod}`, targetMethod);
      targetSymRows = this.db.query<{ name: string; signature: string; file_path: string }, any[]>(methodSql).all(...methodParams)
        .filter(row => {
          if (row.name !== targetMethod) return true;
          // Go indexes bare method names; the receiver in its signature proves identity.
          const receiver = row.signature.match(/^func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?([A-Za-z_]\w*)(?:\[[^\]]+\])?\s*\)/);
          return receiver?.[1] === targetContainer;
        });

      if (targetSymRows.length === 0) {
        return {
          target_symbol: trimmed,
          found_in_index: false,
          warning: `Symbol '${trimmed}' was not found in Septum index${options.domain ? ` for domain '${options.domain}'` : ""}. Method does not exist.`,
          impact_summary: {
            total_dependents: 0,
            risk_level: "unknown",
            affected_files_count: 0,
          },
          inbound_callers: [],
        };
      }
    } else {
      let containerSql = `
        SELECT s.name, f.path AS file_path
        FROM symbols s
        JOIN files f ON s.file_id = f.id
      `;
      const containerParams: any[] = [];
      if (options.domain) {
        containerSql += ` JOIN domains dom ON f.domain_id = dom.id WHERE LOWER(dom.name) = LOWER(?) AND `;
        containerParams.push(options.domain);
      } else {
        containerSql += ` WHERE `;
      }
      containerSql += ` (s.name = ? OR s.name = ? OR s.name LIKE ? OR s.name LIKE ?) `;
      containerParams.push(trimmed, targetContainer, `${targetContainer}::%`, `%::${targetContainer}`);
      targetSymRows = this.db.query<{ name: string; file_path: string }, any[]>(containerSql).all(...containerParams);

      if (targetSymRows.length === 0) {
        return {
          target_symbol: trimmed,
          found_in_index: false,
          warning: `Symbol '${trimmed}' was not found in Septum index${options.domain ? ` for domain '${options.domain}'` : ""}.`,
          impact_summary: {
            total_dependents: 0,
            risk_level: "unknown",
            affected_files_count: 0,
          },
          inbound_callers: [],
        };
      }
    }

    const definingFiles = new Set<string>(
      targetSymRows.map((r) => r.file_path.replace(/\\/g, "/"))
    );
    const definingFileStems = Array.from(
      new Set(
        Array.from(definingFiles)
          .map((p) => p.split("/").pop()?.replace(/\.[^.]+$/, "") || "")
          .filter((s) => s.length >= 2)
      )
    );

    // 2. Query dependencies matching targetContainer, trimmed, import_statement, or defining file stem
    const whereClauses: string[] = [
      "d.target_symbol_or_path LIKE ?",
      "d.import_statement LIKE ?",
      "d.target_symbol_or_path LIKE ?",
    ];
    const queryParams: string[] = [
      `%${targetContainer}%`,
      `%${targetContainer}%`,
      `%${trimmed}%`,
    ];

    for (const stem of definingFileStems) {
      whereClauses.push("d.target_symbol_or_path LIKE ?");
      queryParams.push(`%${stem}%`);
    }

    const depSql = `
      SELECT 
        f.path AS file,
        d.line_number,
        d.target_symbol_or_path,
        d.import_statement,
        dom.name AS domain_name
      FROM dependencies d
      JOIN files f ON d.source_file_id = f.id
      LEFT JOIN domains dom ON f.domain_id = dom.id
      WHERE ${whereClauses.join(" OR ")}
      ORDER BY f.path ASC, d.line_number ASC
    `;
    const rawDepRows = this.db.query<any, string[]>(depSql).all(...queryParams);

    const containerWordRegex = new RegExp(`\\b${escapeRegExp(targetContainer)}\\b`);
    const depRows = rawDepRows.filter((row) => {
      const normCallerFile = String(row.file).replace(/\\/g, "/");
      if (definingFiles.has(normCallerFile)) return false;

      const stmt = String(row.import_statement || "");
      const target = String(row.target_symbol_or_path || "");

      if (containerWordRegex.test(stmt) || containerWordRegex.test(target)) {
        return true;
      }

      // If no named specifier braces are present, accept path match against defining file stem
      if (!stmt.includes("{")) {
        for (const stem of definingFileStems) {
          const stemRegex = new RegExp(`(?:^|[\\\\/])${escapeRegExp(stem)}(?:\\.[^\\\\/]+)?$`);
          if (stemRegex.test(target)) {
            return true;
          }
        }
      }

      return false;
    });

    // 3. Batch-load all symbols for candidate caller files in ONE query (zero N+1)
    const uniqueCallerFiles = Array.from(new Set(depRows.map((r) => String(r.file))));
    const callerSymbolsByFile = new Map<
      string,
      Array<{ name: string; kind: string; line_start: number; line_end: number }>
    >();

    if (uniqueCallerFiles.length > 0) {
      const placeholders = uniqueCallerFiles.map(() => "?").join(",");
      const allCallerSyms = this.db
        .query<
          { name: string; kind: string; line_start: number; line_end: number; path: string },
          string[]
        >(
          `SELECT s.name, s.kind, s.line_start, s.line_end, f.path
           FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE f.path IN (${placeholders})
           ORDER BY (s.line_end - s.line_start) ASC`
        )
        .all(...uniqueCallerFiles);

      for (const sym of allCallerSyms) {
        const list = callerSymbolsByFile.get(sym.path) || [];
        list.push(sym);
        callerSymbolsByFile.set(sym.path, list);
      }
    }

    const findEnclosingSymbol = (
      filePath: string,
      lineNum: number
    ): { name: string; kind: string } | undefined => {
      const syms = callerSymbolsByFile.get(filePath);
      if (!syms) return undefined;
      return syms.find((s) => lineNum >= s.line_start && lineNum <= s.line_end);
    };

    const callersMap = new Map<string, InboundCaller>();

    for (const row of depRows) {
      const enclosing = findEnclosingSymbol(row.file, row.line_number);
      const callerName = enclosing ? enclosing.name : `${row.file}:${row.line_number}`;
      const key = `${row.file}:${row.line_number}:${callerName}`;

      if (!callersMap.has(key)) {
        callersMap.set(key, {
          file: row.file,
          caller: callerName,
          line: row.line_number,
          kind: enclosing?.kind || "import",
          domain: row.domain_name ?? undefined,
        });
      }
    }

    // 4. Scan file content of callers for exact method calls if targetMethod specified
    if (targetMethod) {
      for (const filePath of uniqueCallerFiles) {
        try {
          const fullPath = options.workspaceRoot ? resolve(options.workspaceRoot, filePath) : filePath;
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath, "utf-8");
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (
                line.includes(`->${targetMethod}(`) ||
                line.includes(`::${targetMethod}(`) ||
                line.includes(`.${targetMethod}(`)
              ) {
                const lineNum = i + 1;
                const enclosing = findEnclosingSymbol(filePath, lineNum);
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

    // 5. Determine if symbol exists in index
    const foundInIndex = targetSymRows.length > 0 || depRows.length > 0;
    const warning = foundInIndex
      ? undefined
      : `Symbol '${trimmed}' was not found in Septum index (neither in declared symbols nor tracked dependencies). Risk cannot be assessed without index evidence.`;

    return {
      target_symbol: trimmed,
      found_in_index: foundInIndex,
      warning,
      impact_summary: {
        total_dependents: inboundCallers.length,
        risk_level: foundInIndex ? riskLevel : "unknown",
        affected_files_count: affectedFiles.size,
      },
      inbound_callers: inboundCallers,
    };
  }

  public getFileInboundImpact(filePath: string): {
    direct_dependents_count: number;
    top_consumers: string[];
    symbols_count: number;
    risk_level: "low" | "medium" | "high";
  } {
    const cleanPath = filePath.replace(/\\/g, "/");
    const baseName = cleanPath.split("/").pop()?.replace(/\.[^.]+$/, "") || "";

    const symbols = this.db
      .query<{ name: string }, [string, string]>(
        `SELECT s.name 
         FROM symbols s 
         JOIN files f ON s.file_id = f.id 
         WHERE f.path = ? OR f.path LIKE ?`
      )
      .all(cleanPath, `%${cleanPath}`);

    const matchedFiles = new Set<string>();
    const orConditions: string[] = [];
    const params: string[] = [];

    if (baseName.length >= 3) {
      orConditions.push("d.target_symbol_or_path LIKE ?");
      params.push(`%${cleanPath}%`);
      orConditions.push("d.target_symbol_or_path LIKE ?");
      params.push(`%${baseName}%`);
    }

    for (const sym of symbols.slice(0, 8)) {
      const symName = sym.name.split("::").pop() || sym.name;
      if (symName.length >= 4) {
        orConditions.push("d.target_symbol_or_path LIKE ?");
        params.push(`%${symName}%`);
        orConditions.push("d.import_statement LIKE ?");
        params.push(`%${symName}%`);
      }
    }

    if (orConditions.length > 0) {
      params.push(`%${cleanPath}`);
      const depRows = this.db
        .query<{ file: string }, string[]>(
          `SELECT DISTINCT f.path AS file
           FROM dependencies d
           JOIN files f ON d.source_file_id = f.id
           WHERE (${orConditions.join(" OR ")})
             AND f.path NOT LIKE ?`
        )
        .all(...params);

      for (const row of depRows) {
        matchedFiles.add(row.file);
      }
    }

    const consumerList = Array.from(matchedFiles);
    let riskLevel: "low" | "medium" | "high" = "low";
    if (consumerList.length >= 5) {
      riskLevel = "high";
    } else if (consumerList.length >= 2) {
      riskLevel = "medium";
    }

    return {
      direct_dependents_count: consumerList.length,
      top_consumers: consumerList.slice(0, 5),
      symbols_count: symbols.length,
      risk_level: riskLevel,
    };
  }
}
