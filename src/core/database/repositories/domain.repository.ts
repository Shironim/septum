import type { Database } from "bun:sqlite";
import type {
  DomainCatalogResponse,
  DomainConfig,
  DomainRecord,
  FileRecord,
  SymbolKind,
  SymbolRecord,
} from "../../../types/index.ts";

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
    archetypeFilter?: string
  ): DomainCatalogResponse | null {
    const domain = this.getDomainByName(domainName);
    if (!domain) return null;

    const allowedDeps: string[] = JSON.parse(domain.allowed_deps_json || "[]");
    const forbiddenDeps: string[] = JSON.parse(domain.forbidden_deps_json || "[]");

    let filesQuery = "SELECT * FROM files WHERE domain_id = ?";
    const params: [number, string?] = [domain.id];

    if (archetypeFilter) {
      filesQuery += " AND archetype = ?";
      params.push(archetypeFilter);
    }
    filesQuery += " ORDER BY path ASC";

    const files = this.db.query<FileRecord, any>(filesQuery).all(...params);

    const catalogFiles: DomainCatalogResponse["files"] = [];

    for (const file of files) {
      const symbols = this.db
        .query<SymbolRecord, [number]>(
          "SELECT * FROM symbols WHERE file_id = ? ORDER BY line_start ASC"
        )
        .all(file.id);

      const symbolMap = new Map<
        string,
        {
          name: string;
          kind: SymbolKind;
          properties: string[];
          methods: string[];
          signatures: string[];
        }
      >();

      for (const sym of symbols) {
        if (
          sym.kind === "class" ||
          sym.kind === "interface" ||
          sym.kind === "trait" ||
          sym.kind === "enum"
        ) {
          if (!symbolMap.has(sym.name)) {
            symbolMap.set(sym.name, {
              name: sym.name,
              kind: sym.kind,
              properties: [],
              methods: [],
              signatures: [sym.signature],
            });
          }
        } else if (sym.kind === "method") {
          let targetContainer = Array.from(symbolMap.values()).pop();
          if (sym.name.includes("::")) {
            const containerName = sym.name.split("::")[0];
            if (symbolMap.has(containerName)) {
              targetContainer = symbolMap.get(containerName);
            }
          }
          if (targetContainer) {
            targetContainer.methods.push(sym.signature);
          } else {
            symbolMap.set(sym.name, {
              name: sym.name,
              kind: sym.kind,
              properties: [],
              methods: [],
              signatures: [sym.signature],
            });
          }
        } else if (sym.kind === "property") {
          let targetContainer = Array.from(symbolMap.values()).pop();
          if (sym.name.includes("::")) {
            const containerName = sym.name.split("::")[0];
            if (symbolMap.has(containerName)) {
              targetContainer = symbolMap.get(containerName);
            }
          }
          if (targetContainer) {
            targetContainer.properties.push(sym.signature);
          } else {
            symbolMap.set(sym.name, {
              name: sym.name,
              kind: sym.kind,
              properties: [sym.signature],
              methods: [],
              signatures: [sym.signature],
            });
          }
        } else {
          symbolMap.set(sym.name, {
            name: sym.name,
            kind: sym.kind,
            properties: [],
            methods: [],
            signatures: [sym.signature],
          });
        }
      }

      catalogFiles.push({
        path: file.path,
        archetype: file.archetype,
        symbols: Array.from(symbolMap.values()).map((s) => ({
          name: s.name,
          kind: s.kind,
          properties: s.properties.length > 0 ? s.properties : undefined,
          methods: s.methods.length > 0 ? s.methods : undefined,
          signatures: s.signatures.length > 0 ? s.signatures : undefined,
        })),
      });
    }

    return {
      domain: domain.name,
      root: domain.root_path,
      allowed_dependencies: allowedDeps,
      forbidden_dependencies: forbiddenDeps,
      files: catalogFiles,
    };
  }
}
