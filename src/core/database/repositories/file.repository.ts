import type { Database } from "bun:sqlite";
import type { ArchetypeKind, DomainRecord, FileRecord } from "../../../types/index.ts";

export class FileRepository {
  constructor(private db: Database) {}

  public getFileByPath(path: string): FileRecord | null {
    return this.db
      .query<FileRecord, [string]>("SELECT * FROM files WHERE path = ?")
      .get(path);
  }

  public getFileById(id: number): FileRecord | null {
    return this.db
      .query<FileRecord, [number]>("SELECT * FROM files WHERE id = ?")
      .get(id);
  }

  public getFilesByDomain(domainId: number): FileRecord[] {
    return this.db
      .query<FileRecord, [number]>("SELECT * FROM files WHERE domain_id = ? ORDER BY path ASC")
      .all(domainId);
  }

  public upsertFile(
    domainId: number,
    path: string,
    archetype: ArchetypeKind,
    contentHash: string,
    lineCount: number,
    mtimeMs: number = 0,
    sizeBytes: number = 0
  ): number {
    const existing = this.getFileByPath(path);
    if (existing) {
      this.db
        .query(
          `UPDATE files 
           SET domain_id = ?, archetype = ?, content_hash = ?, line_count = ?, mtime_ms = ?, size_bytes = ?, last_scanned_at = CURRENT_TIMESTAMP 
           WHERE id = ?`
        )
        .run(domainId, archetype, contentHash, lineCount, mtimeMs, sizeBytes, existing.id);
      return existing.id;
    } else {
      const result = this.db
        .query(
          `INSERT INTO files (domain_id, path, archetype, content_hash, line_count, mtime_ms, size_bytes) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(domainId, path, archetype, contentHash, lineCount, mtimeMs, sizeBytes);
      return Number(result.lastInsertRowid);
    }
  }

  public updateFileMetadataOnly(id: number, mtimeMs: number, sizeBytes: number): void {
    this.db
      .query(
        `UPDATE files 
         SET mtime_ms = ?, size_bytes = ?, last_scanned_at = CURRENT_TIMESTAMP 
         WHERE id = ?`
      )
      .run(mtimeMs, sizeBytes, id);
  }

  public deleteFilesNotInPaths(domainId: number, validPaths: string[]): number {
    if (validPaths.length === 0) {
      const res = this.db.query("DELETE FROM files WHERE domain_id = ?").run(domainId);
      return Number(res.changes);
    }
    const existingFiles = this.getFilesByDomain(domainId);
    const validSet = new Set(validPaths);
    let deletedCount = 0;
    for (const f of existingFiles) {
      if (!validSet.has(f.path)) {
        this.db.query("DELETE FROM files WHERE id = ?").run(f.id);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  public deleteFile(path: string): void {
    this.db.query("DELETE FROM files WHERE path = ?").run(path);
  }

  public getFileWithDomain(
    filePath: string
  ): { file: FileRecord; domain: DomainRecord } | null {
    const file = this.getFileByPath(filePath);
    if (!file) return null;

    const domain = this.db
      .query<DomainRecord, [number]>("SELECT * FROM domains WHERE id = ?")
      .get(file.domain_id);
    if (!domain) return null;

    return { file, domain };
  }
}
