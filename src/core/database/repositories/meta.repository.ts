import type { Database } from "bun:sqlite";

export class MetaRepository {
  constructor(private db: Database) {}

  public getMeta(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM repo_meta WHERE key = ?")
      .get(key);
    return row ? row.value : null;
  }

  public setMeta(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO repo_meta (key, value, updated_at) 
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
      )
      .run(key, value);
  }

  public getAllMeta(): Record<string, string> {
    const rows = this.db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM repo_meta")
      .all();
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  }
}
