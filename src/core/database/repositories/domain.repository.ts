import type { Database } from "bun:sqlite";
import type {
  DomainCatalogResponse,
  DomainConfig,
  DomainRecord,
  FileRecord,
  SymbolKind,
  SymbolRecord,
} from "../../../types/index.ts";
import { DependencyRepository } from "./dependency.repository.ts";

const CONTAINER_KINDS = new Set<SymbolKind>([
  "class",
  "interface",
  "trait",
  "struct",
  "enum",
]);

export class DomainRepository {
  constructor(private db: Database) {}

  public upsertDomain(name: string, config: DomainConfig): number {
    const normalizedName = name.trim();
    const existing = this.getDomainByName(normalizedName);

    // Merge dependencies and archetypes if existing and incoming is empty
    let allowed = config.allowed_dependencies ?? [];
    let forbidden = config.forbidden_dependencies ?? [];
    let archetypes = config.archetypes ?? {};

    if (existing) {
      if (allowed.length === 0 && existing.allowed_deps_json && existing.allowed_deps_json !== "[]") {
        try {
          allowed = JSON.parse(existing.allowed_deps_json);
        } catch {}
      }
      if (forbidden.length === 0 && existing.forbidden_deps_json && existing.forbidden_deps_json !== "[]") {
        try {
          forbidden = JSON.parse(existing.forbidden_deps_json);
        } catch {}
      }
      if (Object.keys(archetypes).length === 0 && existing.archetypes_json && existing.archetypes_json !== "{}") {
        try {
          archetypes = JSON.parse(existing.archetypes_json);
        } catch {}
      }
    }

    const allowedJson = JSON.stringify(allowed);
    const forbiddenJson = JSON.stringify(forbidden);
    const archetypesJson = JSON.stringify(archetypes);

    const query = `
      INSERT INTO domains (name, root_path, allowed_deps_json, forbidden_deps_json, archetypes_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        root_path = excluded.root_path,
        allowed_deps_json = excluded.allowed_deps_json,
        forbidden_deps_json = excluded.forbidden_deps_json,
        archetypes_json = excluded.archetypes_json,
        updated_at = CURRENT_TIMESTAMP
    `;
    this.db.query(query).run(normalizedName, config.root, allowedJson, forbiddenJson, archetypesJson);

    const record = this.getDomainByName(normalizedName);
    return record?.id ?? 0;
  }

  public getDomainByName(name: string): DomainRecord | null {
    return this.db
      .query<DomainRecord, [string]>("SELECT * FROM domains WHERE LOWER(name) = LOWER(?)")
      .get(name.trim());
  }

  public getAllDomains(): DomainRecord[] {
    return this.db.query<DomainRecord, []>("SELECT * FROM domains ORDER BY name ASC").all();
  }

  public getDomainCatalog(
    domainName: string,
    archetypeFilter?: string,
    options?: { detailLevel?: "compact" | "full"; fileFilter?: string }
  ): DomainCatalogResponse | null {
    const domain = this.getDomainByName(domainName);
    if (!domain) return null;

    const detailLevel = options?.detailLevel ?? "compact";
    const fileFilter = options?.fileFilter?.trim();

    const allowedDeps: string[] = JSON.parse(domain.allowed_deps_json || "[]");
    const forbiddenDeps: string[] = JSON.parse(domain.forbidden_deps_json || "[]");

    let filesQuery = "SELECT * FROM files WHERE domain_id = ?";
    const params: [number, string?] = [domain.id];

    if (archetypeFilter) {
      filesQuery += " AND archetype = ?";
      params.push(archetypeFilter);
    }
    filesQuery += " ORDER BY path ASC";

    const allDomainFiles = this.db.query<FileRecord, any>(filesQuery).all(...params);
    const totalFiles = allDomainFiles.length;

    const files = fileFilter
      ? allDomainFiles.filter((f) =>
          f.path.replace(/\\/g, "/").toLowerCase().includes(fileFilter.replace(/\\/g, "/").toLowerCase())
        )
      : allDomainFiles;

    const catalogFiles: DomainCatalogResponse["files"] = [];

    // Batch retrieve symbols for all files in one query to eliminate N+1 roundtrips
    const symbolsByFileId = new Map<number, SymbolRecord[]>();
    for (const f of files) {
      symbolsByFileId.set(f.id, []);
    }

    if (files.length > 0) {
      const allDomainSymbols = this.db
        .query<SymbolRecord, [number]>(
          `SELECT s.* FROM symbols s
           JOIN files f ON s.file_id = f.id
           WHERE f.domain_id = ?
           ORDER BY s.file_id ASC, s.line_start ASC`
        )
        .all(domain.id);

      for (const sym of allDomainSymbols) {
        const list = symbolsByFileId.get(sym.file_id);
        if (list) {
          list.push(sym);
        }
      }
    }

    // Batch compute file connections for the domain (zero N+1)
    const depRepo = new DependencyRepository(this.db);
    const connectionsByPath = depRepo.getDomainFileConnections(domain.id);

    for (const file of files) {
      const symbols = symbolsByFileId.get(file.id) ?? [];

      const symbolMap = new Map<
        string,
        {
          name: string;
          kind: SymbolKind;
          lineSpan: string;
          properties: string[];
          methods: string[];
          signatures: string[];
        }
      >();

      for (const sym of symbols) {
        const lineSpan = `${sym.line_start}-${sym.line_end}`;
        if (CONTAINER_KINDS.has(sym.kind)) {
          if (!symbolMap.has(sym.name)) {
            symbolMap.set(sym.name, {
              name: sym.name,
              kind: sym.kind,
              lineSpan,
              properties: [],
              methods: [],
              signatures: [sym.signature],
            });
          }
        } else if (sym.kind === "method" || sym.kind === "property") {
          let targetContainer:
            | {
                name: string;
                kind: SymbolKind;
                lineSpan: string;
                properties: string[];
                methods: string[];
                signatures: string[];
              }
            | undefined;

          if (sym.name.includes("::")) {
            const containerName = sym.name.split("::")[0];
            const candidate = symbolMap.get(containerName);
            if (candidate && CONTAINER_KINDS.has(candidate.kind)) {
              targetContainer = candidate;
            }
          }

          if (targetContainer) {
            if (sym.kind === "method") {
              targetContainer.methods.push(sym.signature);
            } else {
              targetContainer.properties.push(sym.signature);
            }
          } else {
            symbolMap.set(sym.name, {
              name: sym.name,
              kind: sym.kind,
              lineSpan,
              properties: sym.kind === "property" ? [sym.signature] : [],
              methods: [],
              signatures: [sym.signature],
            });
          }
        } else {
          if (
            detailLevel === "compact" &&
            (sym.kind === "variable" || sym.kind === "constant") &&
            sym.visibility === "private"
          ) {
            continue;
          }
          symbolMap.set(sym.name, {
            name: sym.name,
            kind: sym.kind,
            lineSpan,
            properties: [],
            methods: [],
            signatures: [sym.signature],
          });
        }
      }

      const rawConn = connectionsByPath.get(file.path);
      const fileConnections = {
        imports_from: rawConn?.imports_from ?? [],
        imported_by_count: rawConn?.imported_by_count ?? 0,
      };

      catalogFiles.push({
        path: file.path,
        archetype: file.archetype,
        line_count: file.line_count,
        connections: fileConnections,
        symbols: Array.from(symbolMap.values()).map((s) => {
          if (detailLevel === "compact") {
            return {
              name: s.name,
              kind: s.kind,
              line_span: s.lineSpan,
              methods_count: s.methods.length > 0 ? s.methods.length : undefined,
              properties_count: s.properties.length > 0 ? s.properties.length : undefined,
            };
          }
          return {
            name: s.name,
            kind: s.kind,
            line_span: s.lineSpan,
            methods_count: s.methods.length > 0 ? s.methods.length : undefined,
            properties_count: s.properties.length > 0 ? s.properties.length : undefined,
            properties: s.properties.length > 0 ? s.properties : undefined,
            methods: s.methods.length > 0 ? s.methods : undefined,
            signatures: s.signatures.length > 0 ? s.signatures : undefined,
          };
        }),
      });
    }

    return {
      domain: domain.name,
      root: domain.root_path,
      detail_level: detailLevel,
      total_files: totalFiles,
      showing_files: catalogFiles.length,
      allowed_dependencies: allowedDeps,
      forbidden_dependencies: forbiddenDeps,
      files: catalogFiles,
      agent_hint:
        detailLevel === "compact"
          ? "Compact view (<400 tokens). Use septum_get_symbol({ symbol }) for exact method signatures, or septum_get_domain_catalog({ domain, detail_level: 'full', file_filter: '<path>' }) for full member lists."
          : undefined,
    };
  }
}
