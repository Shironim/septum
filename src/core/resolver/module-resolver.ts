import { ImportResolver } from "./import-resolver.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import type { SeptumRepository } from "../database/repository.ts";

export interface PathAliasRule {
  prefix: string;
  targets: string[];
}

export interface Psr4Rule {
  prefix: string;
  baseDir: string;
}

export class ModuleResolver {
  private projectRoot: string;
  private repo?: SeptumRepository;
  private tsPaths: PathAliasRule[] = [];
  private tsBaseUrl: string = ".";
  private psr4Rules: Psr4Rule[] = [];
  private configsLoaded = false;
  private fileDomainCache?: Map<string, string>;
  private symbolDomainCache?: Map<string, string>;
  private packageNameCache?: Map<string, string | null>;

  constructor(projectRoot: string = process.cwd(), repo?: SeptumRepository) {
    this.projectRoot = path.resolve(projectRoot);
    this.repo = repo;
  }

  public resolveImport(target: string, sourceFile: string) {
    return new ImportResolver(this.projectRoot, this.repo?.getAllDomains?.().map(domain => domain.root_path) ?? []).resolve(target, sourceFile);
  }

  public setRepository(repo: SeptumRepository): void {
    this.repo = repo;
    this.fileDomainCache = undefined;
    this.symbolDomainCache = undefined;
  }

  public getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Lazily loads project configuration files (tsconfig.json, composer.json)
   */
  public ensureConfigLoaded(): void {
    if (this.configsLoaded) return;
    this.loadTsConfig();
    this.loadComposerJson();
    this.configsLoaded = true;
  }

  private ensureRepoCachesLoaded(): void {
    if (!this.repo) return;
    if (this.fileDomainCache && this.symbolDomainCache) return;

    this.fileDomainCache = new Map<string, string>();
    this.symbolDomainCache = new Map<string, string>();

    if (
      typeof this.repo.getAllDomains === "function" &&
      typeof this.repo.getAllFiles === "function"
    ) {
      const domains = this.repo.getAllDomains();
      const domainById = new Map<number, string>();
      for (const d of domains) {
        domainById.set(d.id, d.name);
      }

      const files = this.repo.getAllFiles();
      const domainByFilePath = new Map<string, string>();
      for (const f of files) {
        const domName = domainById.get(f.domain_id);
        if (domName) {
          this.fileDomainCache.set(f.path, domName);
          const norm = f.path.replace(/\\/g, "/");
          this.fileDomainCache.set(norm, domName);
          domainByFilePath.set(f.path, domName);
        }
      }

      if (typeof this.repo.getAllSymbolsWithFiles === "function") {
        const symbols = this.repo.getAllSymbolsWithFiles();
        for (const s of symbols) {
          const domName = domainByFilePath.get(s.file_path) ?? this.fileDomainCache.get(s.file_path);
          if (domName && !this.symbolDomainCache.has(s.name)) {
            this.symbolDomainCache.set(s.name, domName);
          }
        }
      }
    }
  }

  /**
   * Resolves the domain that owns the given source file.
   */
  public resolveSourceDomain(
    filePath: string,
    config: ValidatedSeptumConfig
  ): string | null {
    return this.matchDomainByPath(filePath, config);
  }

  /**
   * Deterministically resolves an imported module/target to its target domain.
   */
  public resolveTargetDomain(
    targetStatement: string,
    sourceFilePath: string | undefined,
    config: ValidatedSeptumConfig
  ): string | null {
    if (sourceFilePath && (fs.existsSync(path.resolve(this.projectRoot,sourceFilePath)) || this.repo?.getMeta?.("workspace_root"))) {
      const resolution = this.resolveImport(targetStatement,sourceFilePath);
      if (resolution.status !== "resolved" || resolution.coverage === "conditional") return null;
      const domains = [...new Set(resolution.targets.flatMap(target => target.files.map(file => this.matchDomainByPath(file,config))).filter((d): d is string => !!d))];
      return domains.length === 1 ? domains[0]! : null;
    }
    // Legacy index-only/path-policy callers have no physical source evidence.
    this.ensureConfigLoaded();

    const normalizedTarget = targetStatement.trim().replace(/^['"]|['"]$/g, "");
    if (!normalizedTarget) return null;

    // 1. Relative imports: ./ or ../ or Python dot relative . or ..
    if (normalizedTarget.startsWith("./") || normalizedTarget.startsWith("../")) {
      if (sourceFilePath) {
        const sourceAbs = this.toAbsolutePath(sourceFilePath);
        const sourceDir = path.dirname(sourceAbs);
        const resolvedCandidate = path.resolve(sourceDir, normalizedTarget);
        const domainFromPath = this.matchDomainByPath(resolvedCandidate, config);
        if (domainFromPath) return domainFromPath;
      }
    } else if (normalizedTarget.startsWith(".")) {
      // Python style relative import (e.g. .service, ..billing.service)
      if (sourceFilePath) {
        const sourceAbs = this.toAbsolutePath(sourceFilePath);
        const sourceDir = path.dirname(sourceAbs);
        const dotMatch = /^\.+/.exec(normalizedTarget);
        if (dotMatch) {
          const dotCount = dotMatch[0].length;
          const remainder = normalizedTarget.slice(dotCount).replace(/\./g, path.sep);
          const upSteps = "../".repeat(Math.max(0, dotCount - 1));
          const resolvedCandidate = path.resolve(sourceDir, upSteps, remainder);
          const domainFromPath = this.matchDomainByPath(resolvedCandidate, config);
          if (domainFromPath) return domainFromPath;
        }
      }
    }

    // 2. Workspace Package Name Resolution (e.g. @repo/shared-types, @repo/design-system)
    const domainFromPackage = this.matchDomainByPackageName(normalizedTarget, config);
    if (domainFromPackage) return domainFromPackage;

    // 3. Python Absolute Dot-notation: domains.billing.service or app.domains.billing
    if (normalizedTarget.includes(".") && !normalizedTarget.includes("/")) {
      const asPath = normalizedTarget.replace(/\./g, path.sep);
      const candidatePath = path.resolve(this.projectRoot, asPath);
      const domainFromPython = this.matchDomainByPath(candidatePath, config);
      if (domainFromPython) return domainFromPython;
    }

    // 3. TypeScript Path Aliases (tsconfig.json paths)
    const tsResolved = this.resolveTsPathAlias(normalizedTarget);
    if (tsResolved) {
      const domainFromTs = this.matchDomainByPath(tsResolved, config);
      if (domainFromTs) return domainFromTs;
    }

    // 4. PHP PSR-4 Namespaces (composer.json autoload)
    const phpResolved = this.resolvePsr4Namespace(normalizedTarget);
    if (phpResolved) {
      const domainFromPhp = this.matchDomainByPath(phpResolved, config);
      if (domainFromPhp) return domainFromPhp;
    }

    // 4. Database-driven direct file & symbol lookup (pre-cached in memory to eliminate N+1)
    if (this.repo) {
      this.ensureRepoCachesLoaded();
      const normKey = normalizedTarget.replace(/\\/g, "/");
      const cachedFileDomain =
        this.fileDomainCache?.get(normalizedTarget) ?? this.fileDomainCache?.get(normKey);
      if (cachedFileDomain !== undefined) {
        if (cachedFileDomain) return cachedFileDomain;
      } else if (typeof this.repo.getFileWithDomain === "function") {
        const fileRecord = this.repo.getFileWithDomain(normalizedTarget);
        const domName = fileRecord?.domain_name ?? "";
        this.fileDomainCache?.set(normalizedTarget, domName);
        this.fileDomainCache?.set(normKey, domName);
        if (domName) return domName;
      }

      // 5. Database-driven symbol lookup
      const symbolName = this.extractSymbolName(normalizedTarget);
      if (symbolName) {
        const cachedSymDomain = this.symbolDomainCache?.get(symbolName);
        if (cachedSymDomain !== undefined) {
          if (cachedSymDomain) return cachedSymDomain;
        } else if (typeof this.repo.findSymbolWithDomain === "function") {
          const symbolRecord = this.repo.findSymbolWithDomain(symbolName);
          const domName = symbolRecord?.domain_name ?? "";
          this.symbolDomainCache?.set(symbolName, domName);
          if (domName) return domName;
        }
      }
    }

    // 6. Root path segment matching (fallback for explicit domain root references)
    // Only apply if the target explicitly references a domain root or is a path within the workspace
    const normalizedSlash = normalizedTarget.replace(/\\/g, "/").toLowerCase();
    const isBarePackage =
      !normalizedTarget.startsWith(".") &&
      !normalizedTarget.startsWith("/") &&
      !normalizedTarget.includes(path.sep) &&
      !normalizedTarget.includes("/");

    if (!isBarePackage) {
      for (const [domainName, domainCfg] of Object.entries(config.domains)) {
        const domainRootSlash = domainCfg.root.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

        if (
          normalizedSlash === domainRootSlash ||
          normalizedSlash.startsWith(`${domainRootSlash}/`) ||
          normalizedSlash.includes(`/${domainRootSlash}/`)
        ) {
          return domainName;
        }

        const candidateAbs = path.resolve(this.projectRoot, normalizedTarget);
        const domainAbsRoot = this.toAbsolutePath(domainCfg.root);
        if (this.isSubPathOrSame(candidateAbs, domainAbsRoot) && fs.existsSync(candidateAbs)) {
          return domainName;
        }
      }
    }

    return null;
  }

  private matchDomainByPath(targetPath: string, config: ValidatedSeptumConfig): string | null {
    const absTargetPath = this.toAbsolutePath(targetPath);

    const sortedDomains = Object.entries(config.domains)
      .map(([domainName, domainCfg]) => ({
        domainName,
        domainCfg,
        absRoot: this.toAbsolutePath(domainCfg.root),
      }))
      .sort((a, b) => b.absRoot.length - a.absRoot.length);

    for (const { domainName, absRoot } of sortedDomains) {
      if (this.isSubPathOrSame(absTargetPath, absRoot)) {
        return domainName;
      }
    }

    return null;
  }

  private matchDomainByPackageName(target: string, config: ValidatedSeptumConfig): string | null {
    if (!this.packageNameCache) {
      this.packageNameCache = new Map<string, string | null>();
    }

    for (const [domainName, domainCfg] of Object.entries(config.domains)) {
      const pkgJsonPath = path.resolve(this.projectRoot, domainCfg.root, "package.json");
      const cached = this.packageNameCache.get(pkgJsonPath);
      let pkgName: string | null = cached ?? null;
      if (cached === undefined) {
        if (fs.existsSync(pkgJsonPath)) {
          try {
            const raw = fs.readFileSync(pkgJsonPath, "utf8");
            const pkg = JSON.parse(raw);
            if (pkg.name && typeof pkg.name === "string") {
              pkgName = pkg.name;
            }
          } catch {
            // Ignore unreadable or invalid package.json
          }
        }
        this.packageNameCache.set(pkgJsonPath, pkgName);
      }

      if (pkgName && (target === pkgName || target.startsWith(`${pkgName}/`))) {
        return domainName;
      }
    }
    return null;
  }

  public toCanonicalPath(filePath: string): string {
    let resolved = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(this.projectRoot, filePath);

    if (process.platform === "win32") {
      // Normalize drive letter to uppercase (e.g. c:\ -> C:\)
      resolved = resolved.replace(/^[a-zA-Z]:/, (m) => m.toUpperCase());
    }
    return resolved;
  }

  private isSubPathOrSame(targetPath: string, rootPath: string): boolean {
    const canonicalTarget = this.toCanonicalPath(targetPath);
    const canonicalRoot = this.toCanonicalPath(rootPath);

    if (process.platform === "win32") {
      const lowerTarget = canonicalTarget.toLowerCase();
      const lowerRoot = canonicalRoot.toLowerCase();
      if (lowerTarget === lowerRoot) return true;
      const rootWithSep = lowerRoot.endsWith(path.sep)
        ? lowerRoot
        : lowerRoot + path.sep;
      return lowerTarget.startsWith(rootWithSep);
    }

    if (canonicalTarget === canonicalRoot) return true;
    const rootWithSep = canonicalRoot.endsWith(path.sep)
      ? canonicalRoot
      : canonicalRoot + path.sep;

    return canonicalTarget.startsWith(rootWithSep);
  }

  private toAbsolutePath(filePath: string): string {
    return this.toCanonicalPath(filePath);
  }

  private extractSymbolName(target: string): string | null {
    // PHP namespace or TS qualified name: Foo\Bar\Baz or Foo/Bar/Baz or bare Baz
    const cleaned = target.replace(/\\/g, "/");
    const parts = cleaned.split("/").filter(Boolean);
    const lastPart = parts[parts.length - 1];
    if (lastPart && /^[A-Z][a-zA-Z0-9_]*$/.test(lastPart)) {
      return lastPart;
    }
    return null;
  }

  public fileExistsOnDisk(targetPath: string): boolean {
    if (fs.existsSync(targetPath)) {
      try {
        const stat = fs.statSync(targetPath);
        if (stat.isFile()) return true;
        if (stat.isDirectory()) {
          const indexExtensions = [".ts", ".tsx", ".js", ".jsx", ".d.ts"];
          for (const ext of indexExtensions) {
            if (fs.existsSync(path.join(targetPath, `index${ext}`))) {
              return true;
            }
          }
        }
      } catch {
        return false;
      }
    }

    const extensions = [".ts", ".tsx", ".js", ".jsx", ".d.ts", ".json"];
    for (const ext of extensions) {
      if (fs.existsSync(targetPath + ext)) {
        return true;
      }
    }

    const indexExtensions = [".ts", ".tsx", ".js", ".jsx", ".d.ts"];
    for (const ext of indexExtensions) {
      if (fs.existsSync(path.join(targetPath, `index${ext}`))) {
        return true;
      }
    }

    return false;
  }

  private resolveTsPathAlias(target: string): string | null {
    for (const rule of this.tsPaths) {
      if (rule.prefix.endsWith("*")) {
        const basePrefix = rule.prefix.slice(0, -1);
        if (target.startsWith(basePrefix)) {
          const suffix = target.slice(basePrefix.length);
          for (const targetPattern of rule.targets) {
            const candidate = targetPattern.replace("*", suffix);
            const baseDir = path.resolve(this.projectRoot, this.tsBaseUrl);
            const resolved = path.resolve(baseDir, candidate);
            if (this.fileExistsOnDisk(resolved)) {
              return resolved;
            }
          }
        }
      } else if (target === rule.prefix) {
        for (const targetPattern of rule.targets) {
          const baseDir = path.resolve(this.projectRoot, this.tsBaseUrl);
          const resolved = path.resolve(baseDir, targetPattern);
          if (this.fileExistsOnDisk(resolved)) {
            return resolved;
          }
        }
      }
    }
    return null;
  }

  private resolvePsr4Namespace(target: string): string | null {
    // PHP PSR-4: App\Domain\Billing\Service -> app/Domain/Billing/Service.php
    const normalizedTarget = target.replace(/\//g, "\\");

    for (const rule of this.psr4Rules) {
      if (normalizedTarget.startsWith(rule.prefix)) {
        const subNamespace = normalizedTarget.slice(rule.prefix.length);
        const subPath = subNamespace.replace(/\\/g, path.sep);
        const resolved = path.resolve(this.projectRoot, rule.baseDir, subPath);
        if (!resolved.endsWith(".php") && !resolved.endsWith(".inc")) {
          const withPhp = `${resolved}.php`;
          if (fs.existsSync(withPhp)) {
            return withPhp;
          }
        }
        return resolved;
      }
    }
    return null;
  }

  private loadTsConfig(): void {
    const tsconfigPath = path.join(this.projectRoot, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) return;

    try {
      const raw = fs.readFileSync(tsconfigPath, "utf-8");
      // Strip comments (simple JSON with comments regex)
      const cleanJson = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
      const parsed = JSON.parse(cleanJson);
      const compilerOptions = parsed.compilerOptions ?? {};

      this.tsBaseUrl = compilerOptions.baseUrl ?? ".";

      if (compilerOptions.paths && typeof compilerOptions.paths === "object") {
        for (const [key, val] of Object.entries(compilerOptions.paths)) {
          const targets = Array.isArray(val) ? (val as string[]) : [String(val)];
          this.tsPaths.push({
            prefix: key,
            targets,
          });
        }
      }
    } catch {
      // Graceful fallback if tsconfig is malformed
    }
  }

  private loadComposerJson(): void {
    const composerPath = path.join(this.projectRoot, "composer.json");
    if (!fs.existsSync(composerPath)) return;

    try {
      const raw = fs.readFileSync(composerPath, "utf-8");
      const parsed = JSON.parse(raw);

      const extractPsr4 = (section: Record<string, unknown> | undefined) => {
        if (section && typeof section["psr-4"] === "object" && section["psr-4"] !== null) {
          for (const [ns, dir] of Object.entries(section["psr-4"] as Record<string, string>)) {
            this.psr4Rules.push({
              prefix: ns,
              baseDir: String(dir),
            });
          }
        }
      };

      extractPsr4(parsed.autoload);
      extractPsr4(parsed["autoload-dev"]);

      // Sort longest-prefix-first to prevent short prefixes from shadowing specific ones
      this.psr4Rules.sort((a, b) => b.prefix.length - a.prefix.length);
    } catch {
      // Graceful fallback if composer.json is malformed
    }
  }
}
