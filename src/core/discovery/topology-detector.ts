import * as fs from "node:fs";
import * as path from "node:path";
import type { DomainConfig } from "../../types/index.ts";
import type { SeptumRepository } from "../database/repository.ts";

export type ProjectType =
  | "monorepo"
  | "fullstack"
  | "backend"
  | "frontend"
  | "cli-mcp"
  | "generic";

export type ArchitectureStyle =
  | "modular-ddd"
  | "layered-monolith"
  | "clean-architecture"
  | "monorepo-workspaces"
  | "cli-adapter"
  | "generic";

export interface DiscoveredProjectTopology {
  framework: string;
  language: "typescript" | "javascript" | "php" | "python" | "go" | "generic";
  projectType: ProjectType;
  architectureStyle: ArchitectureStyle;
  domains: Record<string, DomainConfig>;
}

export class TopologyDetector {
  private static readonly IGNORED_DIRS = new Set([
    "node_modules",
    "vendor",
    "dist",
    "build",
    ".git",
    ".septum",
    ".system_generated",
    "tests",
    "test",
    "coverage",
    ".vscode",
    ".idea",
    ".agents",
    "bin",
  ]);

  /**
   * Detects project topology, classifies project type & architecture style, and maps domains.
   */
  public static detect(projectRoot: string = process.cwd()): DiscoveredProjectTopology {
    const language = this.detectLanguage(projectRoot);
    const framework = this.detectFramework(projectRoot, language);
    const isMonorepo = this.detectMonorepo(projectRoot);

    const domains: Record<string, DomainConfig> = {};
    let architectureStyle: ArchitectureStyle = "generic";

    // 1. Monorepo Workspaces (apps/*, packages/*)
    if (isMonorepo) {
      architectureStyle = "monorepo-workspaces";
      const workspaceDirs = ["apps", "packages", "modules"];
      const appDomains: string[] = [];
      const packageDomains: string[] = [];

      for (const parent of workspaceDirs) {
        const fullParent = path.join(projectRoot, parent);
        if (fs.existsSync(fullParent) && fs.statSync(fullParent).isDirectory()) {
          const subs = this.getSubdirectories(fullParent);
          for (const sub of subs) {
            const relRoot = path.join(parent, sub);
            const domainName = sub.toLowerCase();
            if (parent === "apps") appDomains.push(domainName);
            else packageDomains.push(domainName);

            domains[domainName] = {
              root: relRoot,
              description: `Monorepo ${parent} package: ${sub}`,
              allowed_dependencies: parent === "apps" ? packageDomains : [],
              forbidden_dependencies: parent !== "apps" ? appDomains : [],
              archetypes: this.inferDefaultArchetypes(path.join(projectRoot, relRoot)),
            };
          }
        }
      }
    }

    // 2. Modular DDD (app/Domain, src/modules, src/domains, etc.)
    if (Object.keys(domains).length === 0) {
      const modularCandidates = [
        { prefix: "domain", dir: path.join(projectRoot, "app", "Domain") },
        { prefix: "domain", dir: path.join(projectRoot, "app", "Domains") },
        { prefix: "domain", dir: path.join(projectRoot, "src", "domains") },
        { prefix: "feature", dir: path.join(projectRoot, "src", "features") },
        { prefix: "module", dir: path.join(projectRoot, "src", "modules") },
      ];

      for (const cand of modularCandidates) {
        if (fs.existsSync(cand.dir) && fs.statSync(cand.dir).isDirectory()) {
          const subdirs = this.getSubdirectories(cand.dir);
          if (subdirs.length > 0) {
            architectureStyle = "modular-ddd";
            for (const sub of subdirs) {
              const relRoot = path.relative(projectRoot, path.join(cand.dir, sub));
              domains[sub.toLowerCase()] = {
                root: relRoot,
                description: `Modular ${cand.prefix} domain: ${sub}`,
                allowed_dependencies: ["shared", "common"],
                forbidden_dependencies: [],
                archetypes: this.inferDefaultArchetypes(path.join(projectRoot, relRoot)),
              };
            }
          }
        }
      }
    }

    // 3. Layered Monolith / Clean Architecture in src/
    const srcDir = path.join(projectRoot, "src");
    if (Object.keys(domains).length === 0 && fs.existsSync(srcDir) && fs.statSync(srcDir).isDirectory()) {
      const subdirs = this.getSubdirectories(srcDir);
      if (subdirs.length > 0) {
        architectureStyle =
          framework === "mcp-server" || framework === "cli"
            ? "cli-adapter"
            : "layered-monolith";

        const sharedKernelNames = new Set(["types", "shared", "common", "contracts"]);
        const coreNames = new Set(["core", "domain", "services", "usecase", "internal"]);
        const adapterNames = new Set([
          "cli",
          "mcp",
          "api",
          "controllers",
          "routes",
          "handlers",
          "delivery",
        ]);

        for (const sub of subdirs) {
          const relRoot = path.join("src", sub);
          const name = sub.toLowerCase();
          let allowed: string[] = [];
          let forbidden: string[] = [];

          if (sharedKernelNames.has(name)) {
            allowed = [];
            forbidden = Array.from(adapterNames)
              .concat(Array.from(coreNames))
              .filter((n) => subdirs.map((s) => s.toLowerCase()).includes(n));
          } else if (coreNames.has(name)) {
            allowed = subdirs
              .map((s) => s.toLowerCase())
              .filter((s) => sharedKernelNames.has(s));
            forbidden = subdirs
              .map((s) => s.toLowerCase())
              .filter((s) => adapterNames.has(s));
          } else {
            // Adapters
            allowed = subdirs
              .map((s) => s.toLowerCase())
              .filter((s) => sharedKernelNames.has(s) || coreNames.has(s));
            forbidden = [];
          }

          domains[name] = {
            root: relRoot,
            description: `${sub} layer`,
            allowed_dependencies: allowed,
            forbidden_dependencies: forbidden,
            archetypes: this.inferDefaultArchetypes(path.join(projectRoot, relRoot)),
          };
        }
      }
    }

    // 4. Framework-specific structural patterns (Laravel, Go)
    if (Object.keys(domains).length === 0) {
      if (language === "php" || framework.includes("laravel")) {
        const appDir = path.join(projectRoot, "app");
        if (fs.existsSync(appDir)) {
          architectureStyle = "layered-monolith";
          const subdirs = this.getSubdirectories(appDir);
          for (const sub of subdirs) {
            domains[sub.toLowerCase()] = {
              root: path.join("app", sub),
              description: `Laravel layer: ${sub}`,
              allowed_dependencies: [],
              forbidden_dependencies: [],
              archetypes: this.inferDefaultArchetypes(path.join(projectRoot, "app", sub)),
            };
          }
        }
      } else if (language === "go") {
        architectureStyle = "clean-architecture";
        for (const goDir of ["cmd", "internal", "pkg"]) {
          const full = path.join(projectRoot, goDir);
          if (fs.existsSync(full)) {
            domains[goDir] = {
              root: goDir,
              description: `Go layer: ${goDir}`,
              allowed_dependencies:
                goDir === "cmd"
                  ? ["internal", "pkg"]
                  : goDir === "internal"
                  ? ["pkg"]
                  : [],
              forbidden_dependencies: goDir === "pkg" ? ["internal", "cmd"] : [],
              archetypes: this.inferDefaultArchetypes(full),
            };
          }
        }
      }
    }

    // 5. Fallback: Top-level directories
    if (Object.keys(domains).length === 0) {
      const topDirs = this.getSubdirectories(projectRoot);
      for (const d of topDirs) {
        domains[d.toLowerCase()] = {
          root: d,
          description: `Top-level domain: ${d}`,
          allowed_dependencies: [],
          forbidden_dependencies: [],
          archetypes: this.inferDefaultArchetypes(path.join(projectRoot, d)),
        };
      }
    }

    const projectType = this.detectProjectType(projectRoot, framework, language, isMonorepo);

    return {
      framework,
      language,
      projectType,
      architectureStyle,
      domains,
    };
  }

  /**
   * Discovers project topology and persists domains and macro metadata directly into SQLite SSOT.
   */
  public static discoverAndPersist(
    repo: SeptumRepository,
    projectRoot: string = process.cwd()
  ): Record<string, DomainConfig> {
    const topology = this.detect(projectRoot);

    for (const [name, config] of Object.entries(topology.domains)) {
      repo.upsertDomain(name, config);
    }

    // Persist Macro Metadata SSOT
    repo.setMeta("project_type", topology.projectType);
    repo.setMeta("architecture_style", topology.architectureStyle);
    repo.setMeta("framework", topology.framework);
    repo.setMeta("language", topology.language);
    repo.setMeta(
      "macro_summary",
      JSON.stringify({
        projectType: topology.projectType,
        framework: topology.framework,
        architectureStyle: topology.architectureStyle,
        domainsCount: Object.keys(topology.domains).length,
        domains: Object.keys(topology.domains),
      })
    );

    return topology.domains;
  }

  private static detectMonorepo(projectRoot: string): boolean {
    if (
      fs.existsSync(path.join(projectRoot, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(projectRoot, "lerna.json")) ||
      fs.existsSync(path.join(projectRoot, "turbo.json"))
    ) {
      return true;
    }

    const hasApps = fs.existsSync(path.join(projectRoot, "apps"));
    const hasPackages = fs.existsSync(path.join(projectRoot, "packages"));
    if (hasApps && hasPackages) return true;

    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.workspaces && Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0) {
          return true;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Septum Topology] Could not parse ${pkgPath}: ${msg}`);
      }
    }

    return false;
  }

  private static detectProjectType(
    projectRoot: string,
    framework: string,
    language: string,
    isMonorepo: boolean
  ): ProjectType {
    if (isMonorepo) return "monorepo";

    if (framework === "mcp-server" || framework === "cli") return "cli-mcp";

    if (framework === "nextjs" || framework === "nuxt" || framework === "astro") {
      return "fullstack";
    }

    if (framework.includes("laravel")) {
      const hasJs = fs.existsSync(path.join(projectRoot, "resources/js"));
      const hasViews = fs.existsSync(path.join(projectRoot, "resources/views"));
      return hasJs || hasViews ? "fullstack" : "backend";
    }

    if (framework === "vue" || framework === "react") {
      return "frontend";
    }

    if (
      framework === "nestjs" ||
      framework === "express" ||
      framework === "fastify" ||
      language === "go" ||
      language === "python" ||
      language === "php"
    ) {
      return "backend";
    }

    return "generic";
  }

  private static inferDefaultArchetypes(fullDir: string): Record<string, string> {
    const archetypes: Record<string, string> = {};
    if (!fs.existsSync(fullDir)) return archetypes;

    try {
      const items = fs.readdirSync(fullDir, { withFileTypes: true });
      for (const it of items) {
        if (it.isDirectory() && !it.name.startsWith(".")) {
          const name = it.name.toLowerCase();
          archetypes[name] = `${it.name}/**`;
        }
      }
      if (Object.keys(archetypes).length === 0) {
        archetypes["source"] = "**/*.*";
      }
    } catch {}

    return archetypes;
  }

  private static detectLanguage(projectRoot: string): DiscoveredProjectTopology["language"] {
    if (fs.existsSync(path.join(projectRoot, "composer.json"))) return "php";
    if (fs.existsSync(path.join(projectRoot, "go.mod"))) return "go";
    if (
      fs.existsSync(path.join(projectRoot, "pyproject.toml")) ||
      fs.existsSync(path.join(projectRoot, "requirements.txt"))
    ) {
      return "python";
    }
    if (
      fs.existsSync(path.join(projectRoot, "tsconfig.json")) ||
      fs.existsSync(path.join(projectRoot, "package.json"))
    ) {
      return "typescript";
    }
    return "generic";
  }

  private static detectFramework(
    projectRoot: string,
    language: DiscoveredProjectTopology["language"]
  ): string {
    if (language === "php") {
      if (fs.existsSync(path.join(projectRoot, "artisan"))) return "laravel";
      return "generic-php";
    }
    if (language === "typescript" || language === "javascript") {
      try {
        const pkgJson = path.join(projectRoot, "package.json");
        if (fs.existsSync(pkgJson)) {
          const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps.next) return "nextjs";
          if (allDeps.nuxt) return "nuxt";
          if (allDeps.astro) return "astro";
          if (allDeps.vue) return "vue";
          if (allDeps["@nestjs/core"]) return "nestjs";
          if (allDeps["@modelcontextprotocol/sdk"]) return "mcp-server";
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Septum Topology] Failed to inspect dependencies in ${pkgJson}: ${msg}`);
      }
      return "generic-node";
    }
    return "generic";
  }

  private static getSubdirectories(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !this.IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }
}
