import * as fs from "node:fs";
import * as path from "node:path";
import type {
  SchemaFieldSummary,
  SchemaMetadata,
  StackSchemaProvider,
} from "../schema-provider.interface.ts";

export class PrismaSchemaProvider implements StackSchemaProvider {
  public readonly id = "prisma";
  public readonly name = "Prisma Schema Provider";

  public canHandle(projectRoot: string): boolean {
    return (
      fs.existsSync(path.join(projectRoot, "prisma", "schema.prisma")) ||
      fs.existsSync(path.join(projectRoot, "schema.prisma"))
    );
  }

  public resolveEntitySchema(
    projectRoot: string,
    entitySymbol: string,
    _entityFilePath?: string
  ): SchemaMetadata | null {
    const candidatePaths = [
      path.join(projectRoot, "prisma", "schema.prisma"),
      path.join(projectRoot, "schema.prisma"),
    ];

    let schemaPath: string | null = null;
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        schemaPath = p;
        break;
      }
    }

    if (!schemaPath) return null;

    try {
      const content = fs.readFileSync(schemaPath, "utf-8");
      const modelRegex = new RegExp(`model\\s+${entitySymbol}\\s*\\{([^}]+)\\}`, "m");
      const match = modelRegex.exec(content);
      if (!match) return null;

      const body = match[1];
      const lines = body.split("\n");
      const fields: SchemaFieldSummary[] = [];

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("//") || line.startsWith("@@")) continue;

        // Pattern: fieldName FieldType attributes...
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const name = parts[0];
          let type = parts[1];
          const nullable = type.endsWith("?");
          if (nullable) {
            type = type.slice(0, -1);
          }

          const isPrimary = line.includes("@id");
          const isForeign = line.includes("@relation");

          fields.push({
            name,
            type,
            nullable: nullable || undefined,
            isPrimary: isPrimary || undefined,
            isForeign: isForeign || undefined,
          });
        }
      }

      if (fields.length === 0) return null;

      return {
        entityName: entitySymbol,
        tableName: entitySymbol.toLowerCase(),
        schemaSourceFile: path.relative(projectRoot, schemaPath),
        fields,
      };
    } catch {
      return null;
    }
  }
}
