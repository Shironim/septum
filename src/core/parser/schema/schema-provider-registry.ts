import type {
  SchemaMetadata,
  StackSchemaProvider,
} from "./schema-provider.interface.ts";
import { LaravelMigrationSchemaProvider } from "./providers/laravel-migration-provider.ts";
import { PrismaSchemaProvider } from "./providers/prisma-schema-provider.ts";

export class SchemaProviderRegistry {
  private static providers: StackSchemaProvider[] = [
    new LaravelMigrationSchemaProvider(),
    new PrismaSchemaProvider(),
  ];

  /**
   * Registers a custom schema provider.
   */
  public static register(provider: StackSchemaProvider): void {
    this.providers.unshift(provider);
  }

  /**
   * Resolves physical schema metadata across all registered providers.
   */
  public static resolveSchema(
    projectRoot: string,
    entitySymbol: string,
    entityFilePath?: string
  ): SchemaMetadata | null {
    for (const provider of this.providers) {
      if (provider.canHandle(projectRoot)) {
        try {
          const res = provider.resolveEntitySchema(projectRoot, entitySymbol, entityFilePath);
          if (res && !(res instanceof Promise)) {
            return res;
          }
        } catch {
          // Graceful fallback
        }
      }
    }
    return null;
  }
}
