import type { Database } from "bun:sqlite";
import type {
  ArchetypeKind,
  DomainCatalogResponse,
  DomainConfig,
  DomainRecord,
  ExtractedDependency,
  ExtractedSymbol,
  FileRecord,
  GetSymbolDetailsResponse,
  GetSymbolImpactResponse,
  InboundCaller,
  SymbolKind,
  SymbolRecord,
  VerticalSliceRecord,
} from "../../types/index.ts";

export type {
  ArchetypeKind,
  DomainCatalogResponse,
  DomainConfig,
  DomainRecord,
  ExtractedDependency,
  ExtractedSymbol,
  FileRecord,
  GetSymbolDetailsResponse,
  GetSymbolImpactResponse,
  InboundCaller,
  SymbolKind,
  SymbolRecord,
  VerticalSliceRecord,
} from "../../types/index.ts";
import { DependencyRepository } from "./repositories/dependency.repository.ts";
import { DomainRepository } from "./repositories/domain.repository.ts";
import { FileRepository } from "./repositories/file.repository.ts";
import { MetaRepository } from "./repositories/meta.repository.ts";
import { SymbolRepository } from "./repositories/symbol.repository.ts";

export type DatabaseRepository = SeptumRepository;

export class SeptumRepository {
  public readonly domains: DomainRepository;
  public readonly files: FileRepository;
  public readonly symbols: SymbolRepository;
  public readonly dependencies: DependencyRepository;
  public readonly meta: MetaRepository;

  constructor(private db: Database) {
    this.domains = new DomainRepository(db);
    this.files = new FileRepository(db);
    this.symbols = new SymbolRepository(db);
    this.dependencies = new DependencyRepository(db);
    this.meta = new MetaRepository(db);
  }

  public runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- Domain Methods ---
  public upsertDomain(name: string, config: DomainConfig): number {
    return this.domains.upsertDomain(name, config);
  }

  public getDomainByName(name: string): DomainRecord | null {
    return this.domains.getDomainByName(name);
  }

  public getAllDomains(): DomainRecord[] {
    return this.domains.getAllDomains();
  }

  // --- File Methods ---
  public getFileByPath(path: string): FileRecord | null {
    return this.files.getFileByPath(path);
  }

  public getFilesByDomain(domainId: number): FileRecord[] {
    return this.files.getFilesByDomain(domainId);
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
    return this.files.upsertFile(
      domainId,
      path,
      archetype,
      contentHash,
      lineCount,
      mtimeMs,
      sizeBytes
    );
  }

  public updateFileMetadataOnly(id: number, mtimeMs: number, sizeBytes: number): void {
    this.files.updateFileMetadataOnly(id, mtimeMs, sizeBytes);
  }

  public deleteFilesNotInPaths(domainId: number, validPaths: string[]): number {
    return this.files.deleteFilesNotInPaths(domainId, validPaths);
  }

  public deleteFile(path: string): void {
    this.files.deleteFile(path);
  }

  public getDomainCatalog(
    domainName: string,
    archetypeFilter?: string
  ): DomainCatalogResponse | null {
    return this.domains.getDomainCatalog(domainName, archetypeFilter);
  }

  // --- Symbol Methods ---
  public replaceFileSymbols(fileId: number, symbols: ExtractedSymbol[]): void {
    this.symbols.replaceFileSymbols(fileId, symbols);
  }

  public getSymbolsByFileId(fileId: number): SymbolRecord[] {
    return this.symbols.getSymbolsByFileId(fileId);
  }

  public findSymbolsByName(name: string): Array<SymbolRecord & { file_path: string }> {
    return this.symbols.findSymbolsByName(name);
  }

  public findContainers(
    containerName: string
  ): Array<{ file: FileRecord; symbol?: SymbolRecord }> {
    return this.symbols.findContainers(containerName);
  }

  public getAllSymbolsWithFiles(): Array<SymbolRecord & { file_path: string }> {
    return this.symbols.getAllSymbolsWithFiles();
  }

  // --- Dependency & Slice Methods ---
  public replaceFileDependencies(fileId: number, deps: ExtractedDependency[]): void {
    this.dependencies.replaceFileDependencies(fileId, deps);
  }

  public upsertVerticalSlice(
    slice: Omit<VerticalSliceRecord, "id" | "created_at">
  ): void {
    this.dependencies.upsertVerticalSlice(slice);
  }

  public findVerticalSlices(searchTerm: string): VerticalSliceRecord[] {
    return this.dependencies.findVerticalSlices(searchTerm);
  }

  public getAllVerticalSlices(): VerticalSliceRecord[] {
    return this.dependencies.getAllVerticalSlices();
  }

  public clearVerticalSlices(domainId?: number): void {
    this.dependencies.clearVerticalSlices(domainId);
  }

  public getAllDependenciesWithDomains(): Array<{
    source_file: string;
    source_domain: string;
    line_number: number;
    target: string;
    statement: string;
    is_external: boolean;
  }> {
    return this.dependencies.getAllDependenciesWithDomains();
  }

  public findSymbolWithDomain(
    symbolName: string
  ): {
    symbol_name: string;
    kind: string;
    file_path: string;
    domain_name: string;
  } | null {
    return this.symbols.findSymbolWithDomain(symbolName);
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
    return this.symbols.findSymbolWithMembers(symbolName);
  }

  public getFileWithDomain(filePath: string): {
    file_id: number;
    file_path: string;
    domain_name: string;
  } | null {
    return this.symbols.getFileWithDomain(filePath);
  }

  public getHotspotSymbols(options: {
    minLines?: number;
    kind?: SymbolKind;
    domain?: string;
    limit?: number;
  } = {}): Array<SymbolRecord & { file_path: string; domain_name: string }> {
    return this.symbols.getHotspotSymbols(options);
  }

  public getSymbolDetails(
    symbolQuery: string,
    options: { domain?: string; includeDependencies?: boolean } = {}
  ): GetSymbolDetailsResponse | null {
    return this.symbols.getSymbolDetails(symbolQuery, options);
  }

  public getSymbolImpact(symbolName: string): GetSymbolImpactResponse {
    return this.dependencies.getSymbolImpact(symbolName);
  }

  // --- Metadata Methods ---
  public getMeta(key: string): string | null {
    return this.meta.getMeta(key);
  }

  public setMeta(key: string, value: string): void {
    this.meta.setMeta(key, value);
  }

  public getAllMeta(): Record<string, string> {
    return this.meta.getAllMeta();
  }
}

