import * as fs from "node:fs";
import * as path from "node:path";
import type {
  SchemaFieldSummary,
  SchemaMetadata,
  StackSchemaProvider,
} from "../schema-provider.interface.ts";

export class LaravelMigrationSchemaProvider implements StackSchemaProvider {
  public readonly id = "laravel-migration";
  public readonly name = "Laravel Migration Schema Provider";

  public canHandle(projectRoot: string): boolean {
    const migrationsDir = path.join(projectRoot, "database", "migrations");
    return fs.existsSync(migrationsDir) || fs.existsSync(path.join(projectRoot, "artisan"));
  }

  public resolveEntitySchema(
    projectRoot: string,
    entitySymbol: string,
    entityFilePath?: string
  ): SchemaMetadata | null {
    const migrationsDir = path.join(projectRoot, "database", "migrations");
    if (!fs.existsSync(migrationsDir)) return null;

    const tableName = this.resolveTableName(projectRoot, entitySymbol, entityFilePath);
    if (!tableName) return null;

    const migrationFiles = this.findMigrationFilesForTable(migrationsDir, tableName);
    if (migrationFiles.length === 0) return null;

    const fieldsMap = new Map<string, SchemaFieldSummary>();
    let primarySourceFile = migrationFiles[0];

    for (const migFile of migrationFiles) {
      const fullPath = path.join(migrationsDir, migFile);
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        this.extractColumnsFromMigration(content, tableName, fieldsMap);
      } catch {
        // Skip unreadable files
      }
    }

    if (fieldsMap.size === 0) return null;

    const relSourceFile = path.relative(projectRoot, path.join(migrationsDir, primarySourceFile));

    return {
      entityName: entitySymbol,
      tableName,
      schemaSourceFile: relSourceFile,
      fields: Array.from(fieldsMap.values()),
    };
  }

  private resolveTableName(
    projectRoot: string,
    entitySymbol: string,
    entityFilePath?: string
  ): string {
    // 1. Check if model file defines explicit protected $table = '...';
    if (entityFilePath) {
      const fullEntityPath = path.isAbsolute(entityFilePath)
        ? entityFilePath
        : path.join(projectRoot, entityFilePath);
      if (fs.existsSync(fullEntityPath)) {
        try {
          const content = fs.readFileSync(fullEntityPath, "utf-8");
          const tableMatch = /protected\s+\$table\s*=\s*['"]([^'"]+)['"]/.exec(content);
          if (tableMatch) {
            return tableMatch[1];
          }
        } catch {}
      }
    }

    // 2. Derive snake_case plural from entity name (e.g. OrderItem -> order_items)
    return this.pluralize(this.toSnakeCase(entitySymbol));
  }

  private toSnakeCase(str: string): string {
    return str
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .toLowerCase();
  }

  private pluralize(snake: string): string {
    if (snake.endsWith("y") && !/[aeiou]y$/i.test(snake)) {
      return `${snake.slice(0, -1)}ies`;
    }
    if (/(?:s|x|z|ch|sh)$/i.test(snake)) {
      return `${snake}es`;
    }
    return `${snake}s`;
  }

  private findMigrationFilesForTable(migrationsDir: string, tableName: string): string[] {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".php")).sort();
    const matched: string[] = [];

    // Priority 1: *_create_${tableName}_table.php
    const createTarget = `_create_${tableName}_table.php`;
    for (const f of files) {
      if (f.endsWith(createTarget)) {
        matched.push(f);
      }
    }

    // Priority 2: Other migration files altering this table
    for (const f of files) {
      if (matched.includes(f)) continue;
      if (f.includes(`_${tableName}_`)) {
        matched.push(f);
      }
    }

    // If still not found by filename, do a lightweight content search
    if (matched.length === 0) {
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(migrationsDir, f), "utf-8");
          if (
            content.includes(`Schema::create('${tableName}'`) ||
            content.includes(`Schema::create("${tableName}"`) ||
            content.includes(`Schema::table('${tableName}'`) ||
            content.includes(`Schema::table("${tableName}"`)
          ) {
            matched.push(f);
          }
        } catch {}
      }
    }

    return matched;
  }

  private extractColumnsFromMigration(
    content: string,
    tableName: string,
    fieldsMap: Map<string, SchemaFieldSummary>
  ): void {
    const lines = content.split("\n");

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.includes("$table->")) continue;

      // Special shorthand: $table->id();
      if (/\$table->id\s*\(\s*\)/.test(line)) {
        fieldsMap.set("id", { name: "id", type: "id", isPrimary: true });
        continue;
      }

      // Special shorthand: $table->id('custom_id');
      const customIdMatch = /\$table->id\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(line);
      if (customIdMatch) {
        fieldsMap.set(customIdMatch[1], { name: customIdMatch[1], type: "id", isPrimary: true });
        continue;
      }

      // Special shorthand: $table->timestamps();
      if (/\$table->timestamps\s*\(/.test(line)) {
        if (!fieldsMap.has("created_at")) {
          fieldsMap.set("created_at", { name: "created_at", type: "timestamp", nullable: true });
        }
        if (!fieldsMap.has("updated_at")) {
          fieldsMap.set("updated_at", { name: "updated_at", type: "timestamp", nullable: true });
        }
        continue;
      }

      // Special shorthand: $table->softDeletes();
      if (/\$table->softDeletes\s*\(/.test(line)) {
        if (!fieldsMap.has("deleted_at")) {
          fieldsMap.set("deleted_at", { name: "deleted_at", type: "timestamp", nullable: true });
        }
        continue;
      }

      // Special shorthand: $table->rememberToken();
      if (/\$table->rememberToken\s*\(/.test(line)) {
        if (!fieldsMap.has("remember_token")) {
          fieldsMap.set("remember_token", { name: "remember_token", type: "string", nullable: true });
        }
        continue;
      }

      // Standard column definitions: $table->type('column_name', ...)
      const colMatch = /\$table->([a-zA-Z0-9_]+)\s*\(\s*['"]([^'"]+)['"]/.exec(line);
      if (colMatch) {
        const type = colMatch[1];
        const name = colMatch[2];

        // Skip non-column fluent methods like foreign, dropColumn, index, primary
        if (["index", "unique", "primary", "foreign", "dropColumn", "dropForeign"].includes(type)) {
          continue;
        }

        const nullable = line.includes("->nullable()");
        const isPrimary = type === "increments" || type === "bigIncrements" || line.includes("->primary()");
        const isForeign = type.startsWith("foreign") || name.endsWith("_id");

        fieldsMap.set(name, {
          name,
          type,
          nullable: nullable || undefined,
          isPrimary: isPrimary || undefined,
          isForeign: isForeign || undefined,
        });
      }
    }
  }
}
