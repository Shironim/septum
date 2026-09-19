import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ParsedFileAST } from "../../types/index.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { detectArchetype } from "../parser/extractors/base.ts";
import { SemanticSliceExtractorRegistry } from "../parser/extractors/registry.ts";
import { TopologyDetector } from "../discovery/topology-detector.ts";
import { ASTParserEngine } from "../parser/tree-sitter.ts";
import { CallGraphTracer } from "../resolver/call-graph-tracer.ts";
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

  public async run(config: ValidatedSeptumConfig): Promise<IngestionMetrics> {
    const startTime = performance.now();
    let filesScanned = 0;
    let filesUpdated = 0;
    let filesSkipped = 0;
    let symbolsIndexed = 0;
    let dependenciesIndexed = 0;

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

    for (const domainName of domainNames) {
      const domainCfg = config.domains[domainName];
      const domainId = this.repo.upsertDomain(domainName, domainCfg);

      if (!existsSync(domainCfg.root)) {
        continue;
      }

      const workspaceRoot = this.resolveWorkspaceRoot(config, domainCfg.root);
      const normCurrentRoot = domainCfg.root.replace(/\\/g, "/").replace(/^\.\/?/, "");
      const childDomainRoots = domainNames
        .filter((d) => d !== domainName)
        .map((d) => config.domains[d].root.replace(/\\/g, "/").replace(/^\.\/?/, ""))
        .filter((r) => {
          if (!r) return false;
          if (!normCurrentRoot) return true;
          return r.startsWith(normCurrentRoot + "/");
        });

      const collectedFiles = this.collectFiles(
        domainCfg.root,
        workspaceRoot,
        config.settings.ignore_patterns,
        childDomainRoots
      );
      const activeRelPaths: string[] = [];

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

      for (const { fullPath, relPath } of collectedFiles) {
        filesScanned++;
        activeRelPaths.push(relPath);

        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        const mtimeMs = Math.round(stat.mtimeMs);
        const sizeBytes = stat.size;
        const existingFile = this.repo.getFileByPath(relPath);

        // Tier 1: Fast OS metadata check (inode mtime + size + domain match)
        if (
          existingFile &&
          existingFile.domain_id === domainId &&
          existingFile.mtime_ms === mtimeMs &&
          existingFile.size_bytes === sizeBytes
        ) {
          filesSkipped++;
          continue;
        }

        // Tier 2: Content Hash verification
        const content = readFileSync(fullPath, "utf-8");
        const currentHash = computeContentHash(content);

        if (
          existingFile &&
          existingFile.domain_id === domainId &&
          existingFile.content_hash === currentHash
        ) {
          // Content identical despite mtime bump (e.g. touch) - update metadata without re-parsing AST
          this.repo.updateFileMetadataOnly(existingFile.id, mtimeMs, sizeBytes);
          filesSkipped++;
          continue;
        }

        filesUpdated++;
        const lineCount = content.split("\n").length;
        const archetype = detectArchetype(relPath, domainCfg.archetypes ?? {});
        const ast = await this.parserEngine.parseFile(fullPath, content);

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

      // Batch ACID Transaction per domain
      this.repo.runInTransaction(() => {
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

        // State Reconciliation: Prune deleted files from DB
        this.repo.deleteFilesNotInPaths(domainId, activeRelPaths);
      });
    }

    // Framework-Agnostic Semantic Vertical Slice Extraction (via Registry Strategy)
    const detectedTopology = TopologyDetector.detect(projectRoot);
    const semanticSlices = await SemanticSliceExtractorRegistry.extractAllSlices(
      projectRoot,
      detectedTopology.framework
    );

    this.repo.clearVerticalSlices();

    if (semanticSlices.length > 0) {
      for (const slice of semanticSlices) {
        this.repo.upsertVerticalSlice(slice);
      }
    } else {
      // Heuristic Call-Graph Tracer fallback for Clean/Hexagonal or generic architectures
      const callGraphTracer = new CallGraphTracer(this.repo, projectRoot);
      const graphSlices = callGraphTracer.traceAllSlices();
      for (const slice of graphSlices) {
        this.repo.upsertVerticalSlice(slice);
      }
    }

    const durationMs = Math.round(performance.now() - startTime);

    // Update SSOT repo_meta watermark
    this.repo.setMeta("last_sync", new Date().toISOString());
    this.repo.setMeta("files_scanned", String(filesScanned));
    this.repo.setMeta("files_updated", String(filesUpdated));
    this.repo.setMeta("symbols_indexed", String(symbolsIndexed));
    this.repo.setMeta("dependencies_indexed", String(dependenciesIndexed));

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

        if (this.shouldIgnore(relPath, ignorePatterns)) {
          continue;
        }

        if (childDomainRoots.some((child) => relPath === child || relPath.startsWith(child + "/"))) {
          continue;
        }

        try {
          const stat = statSync(fullPath);
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

  private shouldIgnore(path: string, ignorePatterns: string[]): boolean {
    for (const pattern of ignorePatterns) {
      const cleanPattern = pattern.replace(/\/\*\*|\*|\*\*/g, "");
      if (path.includes(cleanPattern)) {
        return true;
      }
    }
    return false;
  }

  private isSourceFile(path: string): boolean {
    return /\.(ts|tsx|js|jsx|mjs|cjs|php|py|go|rs)$/i.test(path);
  }
}
