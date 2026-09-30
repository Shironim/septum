export interface SchemaFieldSummary {
  name: string;
  type: string;
  nullable?: boolean;
  isPrimary?: boolean;
  isForeign?: boolean;
}

export interface SchemaMetadata {
  entityName: string;
  tableName: string;
  schemaSourceFile: string;
  fields: SchemaFieldSummary[];
}

export interface StackSchemaProvider {
  readonly id: string;
  readonly name: string;

  /**
   * Determines if this schema provider can handle the project.
   */
  canHandle(projectRoot: string): boolean;

  /**
   * Resolves physical schema metadata (table name, source file, fields) for a given entity symbol.
   */
  resolveEntitySchema(
    projectRoot: string,
    entitySymbol: string,
    entityFilePath?: string
  ): Promise<SchemaMetadata | null> | SchemaMetadata | null;
}
