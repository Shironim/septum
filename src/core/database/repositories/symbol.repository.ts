import * as fs from "node:fs";
import type { Database } from "bun:sqlite";
import type {
  DomainRecord,
  ExtractedSymbol,
  FileRecord,
  GetSymbolDetailsResponse,
  SymbolKind,
  SymbolRecord,
} from "../../../types/index.ts";

export class SymbolRepository {
  constructor(private db: Database) {}

  public replaceFileSymbols(fileId: number, symbols: ExtractedSymbol[]): void {
    this.db.query("DELETE FROM symbols WHERE file_id = ?").run(fileId);
    if (symbols.length === 0) return;

    const stmt = this.db.query(
      `INSERT INTO symbols (file_id, name, kind, signature, visibility, line_start, line_end, line_count) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const sym of symbols) {
      const lineCount = sym.line_count ?? Math.max(1, sym.line_end - sym.line_start + 1);
      stmt.run(
        fileId,
        sym.name,
        sym.kind,
        sym.signature,
        sym.visibility,
        sym.line_start,
        sym.line_end,
        lineCount
      );
    }
  }

  public getSymbolsByFileId(fileId: number): SymbolRecord[] {
    return this.db
      .query<SymbolRecord, [number]>(
        "SELECT * FROM symbols WHERE file_id = ? ORDER BY line_start ASC"
      )
      .all(fileId);
  }

  public findSymbolsByName(name: string): Array<SymbolRecord & { file_path: string }> {
    const query = `
      SELECT s.*, f.path AS file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.name = ? OR s.name LIKE ?
      ORDER BY s.line_start ASC
    `;
    return this.db
      .query<SymbolRecord & { file_path: string }, [string, string]>(query)
      .all(name, `%::${name}`);
  }

  public findContainers(
    containerName: string
  ): Array<{ file: FileRecord; symbol?: SymbolRecord }> {
    const symbolQuery = `
      SELECT s.*, f.path AS file_path, f.id AS f_id, f.domain_id AS f_domain_id, 
             f.archetype AS f_archetype, f.content_hash AS f_content_hash, 
             f.line_count AS f_line_count, f.mtime_ms AS f_mtime_ms, 
             f.size_bytes AS f_size_bytes, f.last_scanned_at AS f_last_scanned_at
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE (s.name = ? OR s.name LIKE ? OR s.name LIKE ?)
        AND s.kind IN ('class', 'interface', 'trait', 'enum')
      LIMIT 10
    `;
    const rows = this.db
      .query<any, [string, string, string]>(symbolQuery)
      .all(containerName, `%\\${containerName}`, `%/${containerName}`);

    if (rows.length > 0) {
      return rows.map((r) => ({
        file: {
          id: r.f_id,
          domain_id: r.f_domain_id,
          path: r.file_path,
          archetype: r.f_archetype,
          content_hash: r.f_content_hash,
          line_count: r.f_line_count,
          mtime_ms: r.f_mtime_ms,
          size_bytes: r.f_size_bytes,
          last_scanned_at: r.f_last_scanned_at,
        },
        symbol: {
          id: r.id,
          file_id: r.file_id,
          name: r.name,
          kind: r.kind,
          signature: r.signature,
          visibility: r.visibility,
          line_start: r.line_start,
          line_end: r.line_end,
          line_count: r.line_count ?? (r.line_end - r.line_start + 1),
        },
      }));
    }

    const fileQuery = `
      SELECT * FROM files
      WHERE path LIKE ? OR path LIKE ?
      LIMIT 10
    `;
    const files = this.db
      .query<FileRecord, [string, string]>(fileQuery)
      .all(`%/${containerName}.%`, `%\\${containerName}.%`);

    return files.map((file) => ({ file }));
  }

  public getAllSymbolsWithFiles(): Array<SymbolRecord & { file_path: string }> {
    const query = `
      SELECT s.*, f.path AS file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.kind IN ('class', 'method', 'function')
      ORDER BY s.name ASC
    `;
    return this.db.query<SymbolRecord & { file_path: string }, []>(query).all();
  }

  public findSymbolWithDomain(symbolName: string): {
    symbol_name: string;
    kind: string;
    file_path: string;
    domain_name: string;
  } | null {
    const query = `
      SELECT 
        s.name AS symbol_name,
        s.kind,
        f.path AS file_path,
        d.name AS domain_name
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN domains d ON f.domain_id = d.id
      WHERE s.name = ?
      LIMIT 1
    `;
    return this.db.query<any, [string]>(query).get(symbolName) ?? null;
  }

  public findSymbolWithMembers(symbolName: string): {
    symbol_name: string;
    kind: string;
    signature: string;
    file_path: string;
    domain_name: string;
    methods: string[];
    properties: string[];
  } | null {
    const rootQuery = `
      SELECT 
        s.id AS symbol_id,
        s.file_id,
        s.name AS symbol_name,
        s.kind,
        s.signature,
        f.path AS file_path,
        d.name AS domain_name
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN domains d ON f.domain_id = d.id
      WHERE s.name = ?
      LIMIT 1
    `;
    const root = this.db.query<any, [string]>(rootQuery).get(symbolName);
    if (!root) return null;

    const membersQuery = `
      SELECT name, kind, signature
      FROM symbols
      WHERE file_id = ? AND name LIKE ?
      ORDER BY line_start ASC
    `;
    const members = this.db
      .query<any, [number, string]>(membersQuery)
      .all(root.file_id, `${symbolName}::%`);

    const methods: string[] = [];
    const properties: string[] = [];

    for (const m of members) {
      if (m.kind === "method") {
        methods.push(m.signature);
      } else if (m.kind === "property") {
        properties.push(m.signature);
      }
    }

    return {
      symbol_name: root.symbol_name,
      kind: root.kind,
      signature: root.signature,
      file_path: root.file_path,
      domain_name: root.domain_name,
      methods,
      properties,
    };
  }

  public getFileWithDomain(filePath: string): {
    file_id: number;
    file_path: string;
    domain_name: string;
  } | null {
    const query = `
      SELECT 
        f.id AS file_id,
        f.path AS file_path,
        d.name AS domain_name
      FROM files f
      JOIN domains d ON f.domain_id = d.id
      WHERE f.path = ?
      LIMIT 1
    `;
    return this.db.query<any, [string]>(query).get(filePath) ?? null;
  }

  public getHotspotSymbols(options: {
    minLines?: number;
    kind?: SymbolKind;
    domain?: string;
    limit?: number;
  } = {}): Array<SymbolRecord & { file_path: string; domain_name: string }> {
    const minLines = options.minLines ?? 30;
    const limit = options.limit ?? 50;

    let sql = `
      SELECT 
        s.id,
        s.file_id,
        s.name,
        s.kind,
        s.signature,
        s.visibility,
        s.line_start,
        s.line_end,
        s.line_count,
        f.path AS file_path,
        d.name AS domain_name
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN domains d ON f.domain_id = d.id
      WHERE s.line_count >= ?
    `;

    const params: any[] = [minLines];

    if (options.kind) {
      sql += " AND s.kind = ?";
      params.push(options.kind);
    }

    if (options.domain) {
      sql += " AND d.name = ?";
      params.push(options.domain);
    }

    sql += " ORDER BY s.line_count DESC, s.name ASC LIMIT ?";
    params.push(limit);

    return this.db.query<any, any[]>(sql).all(...params);
  }

  public getSymbolDetails(
    symbolQuery: string,
    options: { domain?: string; includeDependencies?: boolean } = {}
  ): GetSymbolDetailsResponse | null {
    const trimmed = symbolQuery.trim();
    if (!trimmed) return null;

    let sql = `
      SELECT 
        s.id,
        s.file_id,
        s.name,
        s.kind,
        s.signature,
        s.visibility,
        s.line_start,
        s.line_end,
        s.line_count,
        f.path AS file_path,
        d.name AS domain_name
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN domains d ON f.domain_id = d.id
      WHERE (s.name = ? OR s.name LIKE ? OR s.name LIKE ?)
    `;

    const params: any[] = [trimmed, `%::${trimmed}`, `${trimmed}::%`];

    if (options.domain) {
      sql += " AND d.name = ?";
      params.push(options.domain);
    }

    sql += " ORDER BY CASE WHEN s.name = ? THEN 1 WHEN s.name LIKE ? THEN 2 ELSE 3 END, s.line_start ASC LIMIT 1";
    params.push(trimmed, `%::${trimmed}`);

    const row = this.db.query<any, any[]>(sql).get(...params);
    if (!row) return null;

    // 1. Sibling methods
    let containerName = "";
    if (row.name.includes("::")) {
      containerName = row.name.split("::")[0];
    }

    let siblingMethods: string[] = [];
    if (containerName) {
      const siblings = this.db
        .query<{ name: string }, [number, string, string]>(
          `SELECT name FROM symbols 
           WHERE file_id = ? AND kind = 'method' AND name != ? AND name LIKE ? 
           ORDER BY line_start ASC LIMIT 30`
        )
        .all(row.file_id, row.name, `${containerName}::%`);
      siblingMethods = siblings.map((s) => s.name.replace(`${containerName}::`, ""));
    } else if (row.kind === "class" || row.kind === "interface" || row.kind === "trait") {
      const classMethods = this.db
        .query<{ name: string }, [number, string]>(
          `SELECT name FROM symbols 
           WHERE file_id = ? AND kind = 'method' AND name LIKE ? 
           ORDER BY line_start ASC LIMIT 30`
        )
        .all(row.file_id, `${row.name}::%`);
      siblingMethods = classMethods.map((s) => s.name.replace(`${row.name}::`, ""));
    }

    // 2. Dependencies Injected (from signature type-hints and constructor)
    const dependenciesInjected = new Set<string>();
    const extractTypeHints = (sig: string) => {
      const paramMatch = sig.match(/\(([^)]*)\)/);
      if (paramMatch && paramMatch[1]) {
        const params = paramMatch[1].split(",");
        const primitiveTypes = new Set([
          "int", "string", "bool", "boolean", "float", "array", "iterable",
          "callable", "void", "mixed", "object", "null", "never", "any", "number", "unknown"
        ]);
        for (const p of params) {
          const parts = p.trim().replace(/^\?/, "").split(/\s+/);
          if (parts.length >= 2) {
            const rawType = parts[0].replace(/\[\]$/, "").replace(/^[\\$]/, "");
            if (rawType && !primitiveTypes.has(rawType.toLowerCase()) && !rawType.startsWith("$")) {
              dependenciesInjected.add(rawType);
            }
          }
        }
      }
    };

    extractTypeHints(row.signature);

    // Also check constructor injection if this is a method
    if (containerName) {
      const ctor = this.db
        .query<{ signature: string }, [number, string, string]>(
          "SELECT signature FROM symbols WHERE file_id = ? AND (name = ? OR name LIKE ?) LIMIT 1"
        )
        .get(row.file_id, `${containerName}::__construct`, `%::__construct`);
      if (ctor) {
        extractTypeHints(ctor.signature);
      }
    }

    // 3. Outbound Calls (inspected from physical source file lines if accessible)
    const outboundCalls = new Set<string>();
    try {
      if (fs.existsSync(row.file_path)) {
        const fileContent = fs.readFileSync(row.file_path, "utf-8");
        const lines = fileContent.split(/\r?\n/);
        const start = Math.max(0, row.line_start - 1);
        const end = Math.min(lines.length, row.line_end);
        const sliceLines = lines.slice(start, end).join("\n");

        // Match Static invocations: ClassName::methodName(
        const staticCalls = sliceLines.matchAll(/([A-Z][a-zA-Z0-9_]+)::([a-zA-Z0-9_]+)\s*\(/g);
        for (const m of staticCalls) {
          if (m[1] !== "self" && m[1] !== "parent" && m[1] !== "static") {
            outboundCalls.add(`${m[1]}::${m[2]}`);
          }
        }

        // Match property calls: $this->property->method(
        const propCalls = sliceLines.matchAll(/\$this->([a-zA-Z0-9_]+)->([a-zA-Z0-9_]+)\s*\(/g);
        for (const m of propCalls) {
          // Capitalize property name for clean domain inference (e.g. orderService -> OrderService::cancelOrder)
          const propName = m[1];
          const methodName = m[2];
          const inferredClass = propName.charAt(0).toUpperCase() + propName.slice(1);
          outboundCalls.add(`${inferredClass}::${methodName}`);
        }
      }
    } catch {
      // Graceful fallback if file not physically accessible
    }

    return {
      symbol: row.name,
      kind: row.kind,
      file_path: row.file_path,
      domain: row.domain_name,
      exact_range: {
        start_line: row.line_start,
        end_line: row.line_end,
        total_lines: row.line_count,
      },
      signature: row.signature,
      visibility: row.visibility,
      dependencies_injected: Array.from(dependenciesInjected),
      outbound_calls: Array.from(outboundCalls),
      sibling_methods: siblingMethods.length > 0 ? siblingMethods : undefined,
    };
  }

}
