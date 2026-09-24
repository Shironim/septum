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

  constructor(projectRoot: string = process.cwd(), repo?: SeptumRepository) {
    this.projectRoot = path.resolve(projectRoot);
    this.repo = repo;
  }

  public setRepository(repo: SeptumRepository): void {
    this.repo = repo;
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

  /**
   * Resolves the domain that owns the given source file.
   */
  public resolveSourceDomain(
    filePath: string,
    config: ValidatedSeptumConfig
  ): string | null {
    const absPath = this.toAbsolutePath(filePath);

    for (const [domainName, domainCfg] of Object.entries(config.domains)) {
      const domainAbsRoot = this.toAbsolutePath(domainCfg.root);
      if (this.isSubPathOrSame(absPath, domainAbsRoot)) {
        return domainName;
      }
    }

    return null;
  }

  /**
   * Deterministically resolves an imported module/target to its target domain.
   */
  public resolveTargetDomain(
    targetStatement: string,
    sourceFilePath: string | undefined,
    config: ValidatedSeptumConfig
  ): string | null {
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

    // 4. Database-driven direct file lookup
    if (this.repo) {
      const fileRecord = this.repo.getFileWithDomain(normalizedTarget);
      if (fileRecord) {
        return fileRecord.domain_name;
      }

      // 5. Database-driven symbol lookup
      const symbolName = this.extractSymbolName(normalizedTarget);
      if (symbolName) {
        const symbolRecord = this.repo.findSymbolWithDomain(symbolName);
        if (symbolRecord) {
          return symbolRecord.domain_name;
        }
      }
    }

    // 6. Root path segment matching (fallback for explicit domain root references)
    const normalizedSlash = normalizedTarget.replace(/\\/g, "/").toLowerCase();
    for (const [domainName, domainCfg] of Object.entries(config.domains)) {
      const domainRootSlash = domainCfg.root.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
      const lowerDomain = domainName.toLowerCase();

      if (
        normalizedSlash.includes(`/${domainRootSlash}/`) ||
        normalizedSlash.startsWith(`${domainRootSlash}/`) ||
        normalizedSlash === domainRootSlash ||
        normalizedSlash.includes(`/${lowerDomain}/`) ||
        normalizedSlash.endsWith(`/${lowerDomain}`)
      ) {
        return domainName;
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
    for (const [domainName, domainCfg] of Object.entries(config.domains)) {
      const pkgJsonPath = path.resolve(this.projectRoot, domainCfg.root, "package.json");
      if (fs.existsSync(pkgJsonPath)) {
        try {
          const raw = fs.readFileSync(pkgJsonPath, "utf8");
          const pkg = JSON.parse(raw);
          if (pkg.name && typeof pkg.name === "string") {
            if (target === pkg.name || target.startsWith(`${pkg.name}/`)) {
              return domainName;
            }
          }
        } catch {
          // Ignore unreadable or invalid package.json
        }
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

  private resolveTsPathAlias(target: string): string | null {
    for (const rule of this.tsPaths) {
      if (rule.prefix.endsWith("*")) {
        const basePrefix = rule.prefix.slice(0, -1);
        if (target.startsWith(basePrefix)) {
          const suffix = target.slice(basePrefix.length);
          for (const targetPattern of rule.targets) {
            const candidate = targetPattern.replace("*", suffix);
            const baseDir = path.resolve(this.projectRoot, this.tsBaseUrl);
            return path.resolve(baseDir, candidate);
          }
        }
      } else if (target === rule.prefix) {
        for (const targetPattern of rule.targets) {
          const baseDir = path.resolve(this.projectRoot, this.tsBaseUrl);
          return path.resolve(baseDir, targetPattern);
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
    } catch {
      // Graceful fallback if composer.json is malformed
    }
  }
}
