import { shouldIgnoreSourcePath } from "../resources/ignore.ts";
import { RESOURCE_LIMITS } from "../resources/limits.ts";
import { readSourceFile, SourceFileLimitError, collectSourceSkips, type SkippedSourceFile, type SourceReadFingerprint } from "../resources/source-files.ts";
import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ParsedFileAST } from "../../types/index.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { detectArchetype } from "../parser/extractors/base.ts";
import { SemanticSliceExtractorRegistry } from "../parser/extractors/registry.ts";
import { TopologyDetector } from "../discovery/topology-detector.ts";
import { ASTParserEngine } from "../parser/tree-sitter.ts";
import { CallGraphTracer } from "../resolver/call-graph-tracer.ts";
import { ModuleResolver } from "../resolver/module-resolver.ts";
import { computeContentHash } from "./hasher.ts";

export interface IngestionMetrics {
  domains_processed: number;
  files_scanned: number;
  files_updated: number;
  files_skipped: number;
  symbols_indexed: number;
  dependencies_indexed: number;
  duration_ms: number;
}

export class IngestionPipeline {
  private repo: SeptumRepository;
  private parserEngine: ASTParserEngine;
  private customWorkspaceRoot?: string;

  constructor(repo: SeptumRepository, workspaceRoot?: string) {
    this.repo = repo;
    this.parserEngine = new ASTParserEngine();
    if (workspaceRoot) {
      this.customWorkspaceRoot = resolve(workspaceRoot);
    }
  }

  public async run(config: ValidatedSeptumConfig, options: { verifyContent?: boolean; signal?: AbortSignal } = {}): Promise<IngestionMetrics> {
    this.repo.setMeta("sync_state", "running");
    try {
      const result = await this.runSync(config, options);
      this.repo.setMeta("sync_state", "complete");
      this.repo.setMeta("sync_error", "");
      return result;
    } catch (error) {
      this.repo.setMeta("sync_state", "error");
      this.repo.setMeta("sync_error", String(error));
      throw error;
    }
  }

  private async runSync(config: ValidatedSeptumConfig, options: { verifyContent?: boolean; signal?: AbortSignal }): Promise<IngestionMetrics> {
    this.ensureParserRevision();
    const startTime = performance.now();
    let filesScanned = 0;
    let filesUpdated = 0;
    let filesSkipped = 0;
    let symbolsIndexed = 0;
    let dependenciesIndexed = 0;
    const unsupportedFiles: string[] = [];
    const skippedFiles: SkippedSourceFile[] = [];
    let removedFiles = 0;

    let domainNames = Object.keys(config.domains);
    const projectRoot = this.customWorkspaceRoot || process.cwd();

    // Auto-discovery mode if no domains explicitly declared in config
    if (domainNames.length === 0) {
      const discovered = this.autoDiscoverDomains(projectRoot);
      for (const [dName, dCfg] of Object.entries(discovered)) {
        config.domains[dName] = {
          root: dCfg.root,
          description: dCfg.description,
          allowed_dependencies: dCfg.allowed_dependencies || [],
          forbidden_dependencies: dCfg.forbidden_dependencies || [],
          archetypes: dCfg.archetypes || {},
        };
      }
      domainNames = Object.keys(config.domains);
    }

    const existingFilesMap = new Map<string, import("../../types/index.ts").FileRecord>();
    for (const f of this.repo.getAllFiles()) {
      existingFilesMap.set(f.path, f);
    }

    for (const domainName of domainNames) {
      const domainCfg = config.domains[domainName];
      const domainId = this.repo.upsertDomain(domainName, domainCfg);
      const workspaceRoot = this.resolveWorkspaceRoot(config, domainCfg.root);
      const absDomainRoot = resolve(workspaceRoot, domainCfg.root);

      if (!existsSync(absDomainRoot)) {
        removedFiles += this.repo.getAllFiles().filter(file => file.domain_id === domainId).length;
        this.repo.files.deleteFilesNotInPaths(domainId, []);
        if (removedFiles) this.repo.setMeta("slices_dirty", "1");
        continue;
      }

      const childDomainRoots = domainNames
        .filter(name => name !== domainName)
        .map(name => relative(workspaceRoot, resolve(workspaceRoot, config.domains[name].root)).replace(/\\/g, "/"))
        .filter(child => {
          const fromParent = relative(absDomainRoot, resolve(workspaceRoot, child)).replace(/\\/g, "/");
          return fromParent !== "" && fromParent !== ".." && !fromParent.startsWith("../") && !isAbsolute(fromParent);
        });

      const collectedFiles = this.collectFiles(
        absDomainRoot,
        workspaceRoot,
        config.settings.ignore_patterns,
        childDomainRoots
      );
      const activeRelPaths = new Set<string>();

      const pendingMetadataUpdates: Array<{
        id: number;
        mtimeMs: number;
        sizeBytes: number;
      }> = [];

      const pendingUpdates: Array<{
        fullPath: string;
        relPath: string;
        contentHash: string;
        lineCount: number;
        archetype: ReturnType<typeof detectArchetype>;
        mtimeMs: number;
        sizeBytes: number;
        ast: ParsedFileAST;
      }> = [];

      let batchBytes = 0;
      const commitBatch = () => {
        this.repo.runInTransaction(() => {
          for (const meta of pendingMetadataUpdates) {
            this.repo.updateFileMetadataOnly(meta.id, meta.mtimeMs, meta.sizeBytes);
          }

          if (pendingUpdates.length) this.repo.setMeta("slices_dirty", "1");
          for (const item of pendingUpdates) {
            const fileId = this.repo.upsertFile(
              domainId,
              item.relPath,
              item.archetype,
              item.contentHash,
              item.lineCount,
              item.mtimeMs,
              item.sizeBytes
            );

            this.repo.replaceFileSymbols(fileId, item.ast.symbols);
            this.repo.replaceFileDependencies(fileId, item.ast.dependencies);

            symbolsIndexed += item.ast.symbols.length;
            dependenciesIndexed += item.ast.dependencies.length;
          }

        });
        pendingUpdates.length = 0;
        pendingMetadataUpdates.length = 0;
        batchBytes = 0;
      };

      for (const { fullPath, relPath } of collectedFiles) {
        options.signal?.throwIfAborted();
        if (pendingMetadataUpdates.length >= RESOURCE_LIMITS.batchFiles) commitBatch();
        filesScanned++;
        if (filesScanned % RESOURCE_LIMITS.batchFiles === 0) { await new Promise<void>(done => setTimeout(done, 0)); options.signal?.throwIfAborted(); }
        activeRelPaths.add(relPath);

        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        const mtimeMs = stat.mtimeMs;
        const sizeBytes = stat.size;
        const existingFile = existingFilesMap.get(relPath);

        // Tier 1: Fast OS metadata check (inode mtime + size + domain match)
        if (
          !options.verifyContent &&
          existingFile &&
          existingFile.domain_id === domainId &&
          existingFile.mtime_ms === mtimeMs &&
          existingFile.size_bytes === sizeBytes
        ) {
          filesSkipped++;
          continue;
        }

        // Tier 2: Content Hash verification
        if (sizeBytes > RESOURCE_LIMITS.sourceBytes) {
          skippedFiles.push({path: relPath, reason: "file_too_large"});
          if (existingFile) removedFiles++;
          this.repo.deleteFileByPath(relPath);
          this.repo.setMeta("slices_dirty", "1");
          continue;
        }
        if (pendingUpdates.length >= RESOURCE_LIMITS.batchFiles || (batchBytes + sizeBytes > RESOURCE_LIMITS.batchBytes && pendingUpdates.length > 0)) { commitBatch(); await new Promise<void>(done => setTimeout(done, 0)); options.signal?.throwIfAborted(); }
        let content: string;
        try { content = readSourceFile(fullPath); }
        catch (error) {
          if (!(error instanceof SourceFileLimitError)) throw error;
          skippedFiles.push({path: relPath, reason: "file_too_large"});
          if (existingFile) removedFiles++;
          this.repo.deleteFileByPath(relPath);
          this.repo.setMeta("slices_dirty", "1");
          continue;
        }
        const currentHash = computeContentHash(content);

        if (
          existingFile &&
          existingFile.domain_id === domainId &&
          existingFile.content_hash === currentHash
        ) {
          // Content identical despite mtime bump (e.g. touch) - queue metadata update for batch transaction
          pendingMetadataUpdates.push({ id: existingFile.id, mtimeMs, sizeBytes });
          filesSkipped++;
          continue;
        }

        const lineCount = content.split("\n").length;
        const archetype = detectArchetype(relPath, domainCfg.archetypes ?? {});
        const ast = await this.parserEngine.parseFile(fullPath, content);
        if (ast.status === "unsupported") {
          unsupportedFiles.push(relPath);
          this.repo.deleteFileByPath(relPath);
          this.repo.setMeta("slices_dirty", "1");
          continue;
        }
        if (ast.status === "degraded") throw new Error(`Cannot reliably index '${relPath}': parser is degraded.`);

        filesUpdated++;
        batchBytes += sizeBytes;
        pendingUpdates.push({
          fullPath,
          relPath,
          contentHash: currentHash,
          lineCount,
          archetype,
          mtimeMs,
          sizeBytes,
          ast,
        });
      }

      commitBatch();
      this.repo.runInTransaction(() => {
        // State Reconciliation: Prune deleted files from DB using pre-loaded existingFilesMap
        for (const [existingPath, existingRecord] of existingFilesMap.entries()) {
          if (existingRecord.domain_id === domainId && !activeRelPaths.has(existingPath)) {
            removedFiles++;
            this.repo.setMeta("slices_dirty", "1");
            this.repo.deleteFileByPath(existingPath);
            existingFilesMap.delete(existingPath);
          }
        }
      });
    }

    options.signal?.throwIfAborted();
    const topologyInputs = ["package.json", "composer.json", "nest-cli.json", "go.mod", "artisan", "tsconfig.json"]
      .map(file => { const target = join(projectRoot, file); return existsSync(target) ? readSourceFile(target) : ""; });
    const semanticRevision = computeContentHash(JSON.stringify([config.domains, topologyInputs]));
    // Membership covers newly added semantic files outside registered domains.
    const inventory = this.collectFiles(projectRoot, projectRoot, config.settings.ignore_patterns).map(({fullPath, relPath}) => {
      const stat = statSync(fullPath);
      const fingerprint = `${stat.size}:${stat.mtimeMs}`;
      return `${relPath}:${fingerprint}`;
    }).sort();
    const inventoryRevision = computeContentHash(JSON.stringify(inventory));
    const priorInputs: SourceReadFingerprint[] = JSON.parse(this.repo.getMeta("semantic_inputs") || "[]");
    let semanticInputChanged = false;
    for (let index = 0; index < priorInputs.length; index++) {
      if (index % RESOURCE_LIMITS.batchFiles === 0) { await new Promise<void>(done => setTimeout(done, 0)); options.signal?.throwIfAborted(); }
      const input = priorInputs[index];
      const file = resolve(projectRoot, input.path);
      if (!existsSync(file)) { semanticInputChanged = true; break; }
      const stat = statSync(file);
      if (stat.size !== input.size || stat.mtimeMs !== input.mtime) { semanticInputChanged = true; break; }
      if (!options.verifyContent) continue;
      try { semanticInputChanged = computeContentHash(readSourceFile(file)) !== input.hash; }
      catch (error) { if (error instanceof SourceFileLimitError) semanticInputChanged = input.hash !== "file_too_large"; else throw error; }
      if (semanticInputChanged) break;
    }
    if (this.repo.getMeta("semantic_inventory") !== inventoryRevision || semanticInputChanged || filesUpdated > 0 || removedFiles > 0 || this.repo.getMeta("slices_dirty") === "1" || this.repo.getMeta("semantic_revision") !== semanticRevision) {
      const extracted = await collectSourceSkips(projectRoot, async () => {
        const detectedTopology = TopologyDetector.detect(projectRoot);
        const semanticSlices = await SemanticSliceExtractorRegistry.extractAllSlices(projectRoot, detectedTopology.framework);
        return semanticSlices.length > 0 ? semanticSlices : new CallGraphTracer(this.repo, projectRoot).traceAllSlices();
      });
      skippedFiles.push(...extracted.skipped);
      this.repo.runInTransaction(() => {
        this.repo.clearVerticalSlices();
        for (const slice of extracted.value) this.repo.upsertVerticalSlice(slice);
        this.repo.setMeta("slices_dirty", "");
        this.repo.setMeta("semantic_revision", semanticRevision);
        this.repo.setMeta("semantic_inventory", inventoryRevision);
        this.repo.setMeta("semantic_inputs", JSON.stringify(extracted.inputs));
        this.repo.setMeta("semantic_skipped_files", JSON.stringify(extracted.skipped));
      });
    }

    skippedFiles.push(...JSON.parse(this.repo.getMeta("semantic_skipped_files") || "[]"));
    const durationMs = Math.round(performance.now() - startTime);

    // Update SSOT repo_meta watermark
    this.repo.runInTransaction(() => {
      this.repo.setMeta("last_sync", new Date().toISOString());
      this.repo.setMeta("sync_duration_ms", String(durationMs));
      this.repo.setMeta("files_scanned", String(filesScanned));
      this.repo.setMeta("files_updated", String(filesUpdated));
      this.repo.setMeta("symbols_indexed", String(symbolsIndexed));
      this.repo.setMeta("dependencies_indexed", String(dependenciesIndexed));
      this.repo.setMeta("unsupported_files", JSON.stringify(unsupportedFiles));
      this.repo.setMeta("skipped_files", JSON.stringify([...new Map(skippedFiles.map(file => [file.path, file])).values()]));
    });

    this.repo.checkpoint();

    return {
      domains_processed: domainNames.length,
      files_scanned: filesScanned,
      files_updated: filesUpdated,
      files_skipped: filesSkipped,
      symbols_indexed: symbolsIndexed,
      dependencies_indexed: dependenciesIndexed,
      duration_ms: durationMs,
    };
  }

  public autoDiscoverDomains(projectRoot: string): Record<string, import("../../types/index.ts").DomainConfig> {
    const domains: Record<string, import("../../types/index.ts").DomainConfig> = {};

    // 1. Modular / DDD check
    const candidateDirs = [
      { name: "domains", rel: "src/domains" },
      { name: "features", rel: "src/features" },
      { name: "modules", rel: "src/modules" },
      { name: "domain", rel: "app/Domain" },
      { name: "domains_app", rel: "app/Domains" },
    ];

    for (const c of candidateDirs) {
      const fullDir = join(projectRoot, c.rel);
      if (existsSync(fullDir)) {
        try {
          const subdirs = readdirSync(fullDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);

          if (subdirs.length > 0) {
            for (const sub of subdirs) {
              domains[sub.toLowerCase()] = {
                root: `${c.rel}/${sub}`,
                description: `${sub} domain (auto-discovered)`,
                allowed_dependencies: [],
                forbidden_dependencies: [],
                archetypes: {
                  service: "*Service.*",
                  model: "*Model.*",
                  repository: "*Repository.*",
                },
              };
            }
            return domains;
          }
        } catch {}
      }
    }

    // 2. Framework: Laravel
    const hasArtisan = existsSync(join(projectRoot, "artisan"));
    let isLaravel = hasArtisan;
    if (!isLaravel && existsSync(join(projectRoot, "composer.json"))) {
      try {
        const comp = readFileSync(join(projectRoot, "composer.json"), "utf-8");
        if (comp.includes("laravel/framework")) isLaravel = true;
      } catch {}
    }

    if (isLaravel) {
      domains["app"] = {
        root: "app",
        description: "Core Laravel Application (auto-discovered)",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {
          controller: "app/Http/Controllers/**",
          service: "app/Services/**",
          model: "app/Models/**",
          repository: "app/Repositories/**",
          action: "app/Actions/**",
          job: "app/Jobs/**",
          event: "app/Events/**",
          listener: "app/Listeners/**",
          request: "app/Http/Requests/**",
          middleware: "app/Http/Middleware/**",
        },
      };

      if (existsSync(join(projectRoot, "resources/views"))) {
        domains["views"] = {
          root: "resources/views",
          description: "Laravel Blade Templates and UI Views (auto-discovered)",
          allowed_dependencies: [],
          forbidden_dependencies: [],
          archetypes: {
            view: "resources/views/**/*.blade.php",
          },
        };
      }

      if (existsSync(join(projectRoot, "routes"))) {
        domains["routes"] = {
          root: "routes",
          description: "Laravel HTTP Route Definitions (auto-discovered)",
          allowed_dependencies: [],
          forbidden_dependencies: [],
          archetypes: {
            route: "routes/**/*.php",
          },
        };
      }

      if (existsSync(join(projectRoot, "database"))) {
        domains["database"] = {
          root: "database",
          description: "Laravel Migrations and Database Schemas (auto-discovered)",
          allowed_dependencies: [],
          forbidden_dependencies: [],
          archetypes: {
            migration: "database/migrations/**/*.php",
          },
        };
      }

      return domains;
    }

    // 3. Framework: NestJS
    const hasNestCli = existsSync(join(projectRoot, "nest-cli.json"));
    let isNest = hasNestCli;
    if (!isNest && existsSync(join(projectRoot, "package.json"))) {
      try {
        const pkg = readFileSync(join(projectRoot, "package.json"), "utf-8");
        if (pkg.includes("@nestjs/core")) isNest = true;
      } catch {}
    }

    if (isNest) {
      domains["src"] = {
        root: "src",
        description: "NestJS Source Domain (auto-discovered)",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {
          controller: "src/**/*.controller.ts",
          service: "src/**/*.service.ts",
          repository: "src/**/*.repository.ts",
        },
      };
      return domains;
    }

    // 4. Framework: Go
    if (existsSync(join(projectRoot, "go.mod"))) {
      if (existsSync(join(projectRoot, "internal"))) {
        domains["internal"] = {
          root: "internal",
          description: "Internal business logic packages",
        };
      }
      if (existsSync(join(projectRoot, "pkg"))) {
        domains["pkg"] = {
          root: "pkg",
          description: "Public library packages",
        };
      }
      if (existsSync(join(projectRoot, "cmd"))) {
        domains["cmd"] = {
          root: "cmd",
          description: "Application command entry points",
        };
      }
      if (Object.keys(domains).length > 0) return domains;
    }

    // 5. General project fallback (src or root)
    if (existsSync(join(projectRoot, "src"))) {
      domains["src"] = {
        root: "src",
        description: "Default Source Domain (auto-discovered)",
      };
    } else {
      domains["root"] = {
        root: ".",
        description: "Root Domain (auto-discovered)",
      };
    }

    return domains;
  }

  private collectFiles(
    dir: string,
    workspaceRoot: string,
    ignorePatterns: string[],
    childDomainRoots: string[] = []
  ): Array<{ fullPath: string; relPath: string }> {
    const results: Array<{ fullPath: string; relPath: string }> = [];

    const walk = (currentDir: string) => {
      let entries: string[] = [];
      try {
        entries = readdirSync(currentDir);
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = join(currentDir, entry);
        const relPath = relative(workspaceRoot, fullPath).replace(/\\/g, "/");

        if (shouldIgnoreSourcePath(relPath, ignorePatterns)) {
          continue;
        }

        if (childDomainRoots.some((child) => relPath === child || relPath.startsWith(child + "/"))) {
          continue;
        }

        try {
          const stat = lstatSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
          } else if (stat.isFile() && this.isSourceFile(fullPath)) {
            results.push({ fullPath, relPath });
          }
        } catch {
          // ignore unreadable files
        }
      }
    };

    walk(dir);
    return results;
  }

  private resolveWorkspaceRoot(config: ValidatedSeptumConfig, domainRoot: string): string {
    if (this.customWorkspaceRoot) {
      return this.customWorkspaceRoot;
    }
    const settings = config.settings as Record<string, unknown> | undefined;
    if (typeof settings?.workspace_root === "string" && settings.workspace_root.trim()) {
      return resolve(settings.workspace_root);
    }
    if (config.settings.db_path && config.settings.db_path !== ":memory:") {
      const dbDir = dirname(resolve(config.settings.db_path));
      const candidate = basename(dbDir) === ".septum" ? dirname(dbDir) : dbDir;
      const absDomainRoot = resolve(domainRoot);
      if (absDomainRoot.startsWith(candidate)) {
        return candidate;
      }
    }
    return process.cwd();
  }


  private isSourceFile(path: string): boolean {
    return ASTParserEngine.isSourceFile(path);
  }

  private ensureParserRevision(): void {
    const revision = "2";
    if (this.repo.getMeta("parser_revision") === revision) return;
    this.repo.runInTransaction(() => {
      for (const file of this.repo.getAllFiles()) {
        this.repo.upsertFile(file.domain_id, file.path, file.archetype, "", file.line_count, -1, -1);
      }
      this.repo.clearVerticalSlices();
      this.repo.setMeta("parser_revision", revision);
    });
  }

  /**
   * JIT single-file ingestion: quickly verifies and updates a single file's AST,
   * symbols, and dependencies in SQLite if its mtime or content hash has changed.
   */
  public async ingestFile(targetFilePath: string, config: ValidatedSeptumConfig): Promise<boolean> {
    this.ensureParserRevision();
    const fullPath = resolve(targetFilePath);
    if (!existsSync(fullPath)) return false;

    let stat;
    try {
      stat = statSync(fullPath);
      if (!stat.isFile() || !this.isSourceFile(fullPath)) return false;
    } catch {
      return false;
    }

    const mtimeMs = stat.mtimeMs;
    const sizeBytes = stat.size;

    const projectRoot = this.customWorkspaceRoot || process.cwd();
    const relPath = relative(projectRoot, fullPath).replace(/\\/g, "/");

    if (shouldIgnoreSourcePath(relPath, config.settings.ignore_patterns ?? [])) {
      return false;
    }

    const targetDomainName = new ModuleResolver(projectRoot, this.repo).resolveSourceDomain(fullPath, config);
    const targetDomainCfg = targetDomainName ? config.domains[targetDomainName] : null;

    if (!targetDomainName || !targetDomainCfg) {
      return false;
    }

    const domainId = this.repo.upsertDomain(targetDomainName, targetDomainCfg);
    const existingFile = this.repo.getFileByPath(relPath);

    let content: string;
    try { content = readSourceFile(fullPath); }
    catch (error) {
      if (!(error instanceof SourceFileLimitError)) throw error;
      this.repo.runInTransaction(() => {
        this.repo.deleteFileByPath(relPath);
        this.repo.clearVerticalSlices();
        this.repo.setMeta("slices_dirty", "1");
        const skipped: SkippedSourceFile[] = JSON.parse(this.repo.getMeta("skipped_files") || "[]");
        this.repo.setMeta("skipped_files", JSON.stringify([...skipped.filter(file => file.path !== relPath), {path: relPath, reason: "file_too_large"}]));
      });
      return false;
    }
    const currentHash = computeContentHash(content);

    // Tier 2: Hash verification
    if (existingFile && existingFile.domain_id === domainId && existingFile.content_hash === currentHash) {
      this.repo.updateFileMetadataOnly(existingFile.id, mtimeMs, sizeBytes);
      return false;
    }

    const lineCount = content.split("\n").length;
    const archetype = detectArchetype(relPath, targetDomainCfg.archetypes ?? {});
    const ast = await this.parserEngine.parseFile(fullPath, content);
    if (ast.status === "unsupported") {
      this.repo.deleteFileByPath(relPath);
      const unsupported = new Set<string>(JSON.parse(this.repo.getMeta("unsupported_files") || "[]"));
      unsupported.add(relPath);
      this.repo.setMeta("unsupported_files", JSON.stringify([...unsupported]));
      return false;
    }
    if (ast.status === "degraded") throw new Error(`Cannot reliably index '${relPath}': parser is degraded.`);

    this.repo.runInTransaction(() => {
      const fileId = this.repo.upsertFile(
        domainId,
        relPath,
        archetype,
        currentHash,
        lineCount,
        mtimeMs,
        sizeBytes
      );
      this.repo.replaceFileSymbols(fileId, ast.symbols);
      this.repo.replaceFileDependencies(fileId, ast.dependencies);
      this.repo.clearVerticalSlices();
      this.repo.setMeta("slices_dirty", "1");
      const skipped: SkippedSourceFile[] = JSON.parse(this.repo.getMeta("skipped_files") || "[]");
      this.repo.setMeta("skipped_files", JSON.stringify(skipped.filter(file => file.path !== relPath)));
      const unsupported = JSON.parse(this.repo.getMeta("unsupported_files") || "[]") as string[];
      this.repo.setMeta("unsupported_files", JSON.stringify(unsupported.filter(path => path !== relPath)));
    });

    return true;
  }
}

