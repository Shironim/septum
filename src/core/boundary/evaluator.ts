import { posix, relative, resolve, isAbsolute } from "node:path";
import type { BoundaryViolation } from "../../types/index.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import { ConfigLoader } from "../config/loader.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { ModuleResolver } from "../resolver/module-resolver.ts";
import { matchesSimpleGlob } from "../parser/extractors/base.ts";

export class BoundaryEvaluator {
  private repo: SeptumRepository;
  private resolver: ModuleResolver;

  constructor(repo: SeptumRepository, resolver?: ModuleResolver) {
    this.repo = repo;
    this.resolver = resolver ?? new ModuleResolver(process.cwd(), repo);
  }

  public getResolver(): ModuleResolver {
    return this.resolver;
  }

  public evaluate(
    filePath: string,
    proposedImports: string[] = [],
    featureKey?: string,
    config?: ValidatedSeptumConfig
  ): BoundaryViolation[] {
    let activeConfig = config;
    if (!activeConfig) {
      const fromRepo = ConfigLoader.loadFromRepository(this.repo);
      activeConfig =
        Object.keys(fromRepo.domains).length > 0
          ? fromRepo
          : ConfigLoader.loadFromDatabaseOrDefaults();
    }
    const violations: BoundaryViolation[] = [];

    if (featureKey) {
      violations.push(...this.checkFeatureTouchpoints(featureKey, filePath, activeConfig));
    }

    if (proposedImports.length > 0) {
      violations.push(...this.checkProposedChanges(filePath, proposedImports, activeConfig));
    }

    return violations;
  }

  public auditCodebase(config: ValidatedSeptumConfig): BoundaryViolation[] {
    const violations: BoundaryViolation[] = [];
    const allDependencies = this.repo.getAllDependenciesWithDomains();

    const evidence = this.repo.getMeta?.("workspace_root") ? this.repo.getImportRelationships(this.resolver.getProjectRoot()) : undefined;
    for (const dep of allDependencies) {
      if (evidence && !evidence.some(edge => edge.source.file === dep.source_file && edge.source.line === dep.line_number && edge.freshness === "current" && edge.resolution.status === "resolved" && edge.resolution.coverage !== "conditional")) continue;
      const targetDomain = this.resolveTargetDomain(dep.target, config, dep.source_file);
      if (!targetDomain || targetDomain === dep.source_domain) {
        continue;
      }

      const sourceDomainConfig = config.domains[dep.source_domain];
      if (!sourceDomainConfig) {
        continue;
      }

      const forbidden = sourceDomainConfig.forbidden_dependencies ?? [];
      const allowed = sourceDomainConfig.allowed_dependencies ?? [];

      // 1. Explicit forbidden check
      if (forbidden.includes(targetDomain)) {
        violations.push({
          file: dep.source_file,
          line: dep.line_number,
          source_domain: dep.source_domain,
          target_domain: targetDomain,
          imported_target: dep.target,
          rule: "forbidden_dependency",
          message: `Forbidden cross-domain dependency detected: '${dep.source_domain}' is strictly prohibited from importing domain '${targetDomain}'.`,
        });
        continue;
      }

      // 2. Strict enforcement allowed check
      if (config.settings.enforcement === "strict" && !allowed.includes(targetDomain)) {
        violations.push({
          file: dep.source_file,
          line: dep.line_number,
          source_domain: dep.source_domain,
          target_domain: targetDomain,
          imported_target: dep.target,
          rule: "disallowed_dependency",
          message: `Disallowed dependency: '${targetDomain}' is not declared in allowed_dependencies for domain '${dep.source_domain}'.`,
        });
      }
    }

    const currentDependencies = evidence ? allDependencies.filter(dep => evidence.some(edge => edge.source.file === dep.source_file && edge.source.line === dep.line_number && edge.freshness === "current")) : allDependencies;
    violations.push(...this.detectCircularDependencies(config, currentDependencies));

    return violations;
  }

  public detectCircularDependencies(
    config: ValidatedSeptumConfig,
    preloadedDeps?: Array<{
      source_file: string;
      source_domain: string;
      line_number: number;
      target: string;
      statement: string;
      is_external: boolean;
    }>,
    relevantFiles?: ReadonlySet<string>
  ): BoundaryViolation[] {
    const violations: BoundaryViolation[] = [];
    let allDependencies = preloadedDeps ?? this.repo.getAllDependenciesWithDomains();
    if (!preloadedDeps && this.repo.getMeta?.("workspace_root")) {
      const current = this.repo.getImportRelationships(this.resolver.getProjectRoot());
      allDependencies = allDependencies.filter(dep => current.some(edge => edge.source.file === dep.source_file && edge.source.line === dep.line_number && edge.freshness === "current"));
    }

    // Prepare file lookup maps for internal file-to-file resolution
    const fileByNormPath = new Map<string, string>();
    const fileByNoExtPath = new Map<string, string>();

    const registerKnownFile = (rawPath: string) => {
      const norm = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
      fileByNormPath.set(norm.toLowerCase(), rawPath);
      const noExt = norm.replace(/\.[^/.]+$/, "").toLowerCase();
      fileByNoExtPath.set(noExt, rawPath);
      if (noExt.endsWith("/index")) {
        fileByNoExtPath.set(noExt.slice(0, -"/index".length), rawPath);
      }
    };

    if (typeof this.repo.getAllFiles === "function") {
      for (const f of this.repo.getAllFiles()) {
        registerKnownFile(f.path);
      }
    }
    for (const d of allDependencies) {
      registerKnownFile(d.source_file);
    }

    const resolveTargetFile = (sourceFile: string, rawTarget: string): string | null => {
      if (this.repo.getMeta?.("workspace_root")) {
        const result = this.resolver.resolveImport(rawTarget,sourceFile);
        const files = result.targets.flatMap(target => target.files);
        return result.status === "resolved" && result.coverage !== "conditional" && files.length === 1 ? files[0]! : null;
      }
      const cleaned = rawTarget.trim().replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
      if (!cleaned) return null;

      if (cleaned.startsWith(".")) {
        const srcDir = posix.dirname(sourceFile.replace(/\\/g, "/"));
        const joined = posix.normalize(posix.join(srcDir, cleaned)).replace(/^\.\//, "");
        const lowerJoined = joined.toLowerCase();
        const exact =
          fileByNormPath.get(lowerJoined) ??
          fileByNoExtPath.get(lowerJoined.replace(/\.[^/.]+$/, ""));
        if (exact) return exact;
      }

      const aliasClean = cleaned.replace(/^@\//, "src/").replace(/^\.\//, "");
      const lowerAlias = aliasClean.toLowerCase();
      const byAlias =
        fileByNormPath.get(lowerAlias) ??
        fileByNoExtPath.get(lowerAlias.replace(/\.[^/.]+$/, ""));
      if (byAlias) return byAlias;

      return null;
    };

    type EdgeMeta = {
      files: Set<string>;
      file: string;
      line: number;
      source_domain: string;
      target_domain: string;
      target: string;
    };

    const fileGraph = new Map<string, Map<string, EdgeMeta>>();
    const domainGraph = new Map<string, Map<string, EdgeMeta>>();

    for (const dep of allDependencies) {
      if (this.repo.getMeta?.("workspace_root")) {
        const result = this.resolver.resolveImport(dep.target,dep.source_file);
        if (result.status !== "resolved" || result.coverage === "conditional") continue;
      } else if (dep.is_external) continue;

      const targetDomain = this.resolveTargetDomain(dep.target, config, dep.source_file);

      // 1. Domain-to-domain edge
      if (targetDomain && targetDomain !== dep.source_domain) {
        let outMap = domainGraph.get(dep.source_domain);
        if (!outMap) {
          outMap = new Map();
          domainGraph.set(dep.source_domain, outMap);
        }
        if (!outMap.has(targetDomain)) {
          outMap.set(targetDomain, {
            files: new Set([dep.source_file]),
            file: dep.source_file,
            line: dep.line_number,
            source_domain: dep.source_domain,
            target_domain: targetDomain,
            target: dep.target,
          });
        }
        outMap.get(targetDomain)!.files.add(dep.source_file);
      }

      // 2. File-to-file edge
      const targetFile = resolveTargetFile(dep.source_file, dep.target);
      if (targetFile && targetFile !== dep.source_file) {
        let outMap = fileGraph.get(dep.source_file);
        if (!outMap) {
          outMap = new Map();
          fileGraph.set(dep.source_file, outMap);
        }
        if (!outMap.has(targetFile)) {
          outMap.set(targetFile, {
            files: new Set([dep.source_file]),
            file: dep.source_file,
            line: dep.line_number,
            source_domain: dep.source_domain,
            target_domain: targetDomain ?? dep.source_domain,
            target: dep.target,
          });
        }
      }
    }

    const findCycles = (
      graph: Map<string, Map<string, EdgeMeta>>,
      kindLabel: "file" | "domain"
    ) => {
      const visited = new Set<string>();
      const inStack = new Set<string>();
      const stack: string[] = [];
      const reportedCycles = new Set<string>();

      const canonicalizeCycle = (nodes: string[]): string => {
        if (nodes.length === 0) return "";
        let minIdx = 0;
        for (let i = 1; i < nodes.length; i++) {
          if (nodes[i] < nodes[minIdx]) minIdx = i;
        }
        const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
        return rotated.join("->");
      };

      const dfs = (node: string) => {
        visited.add(node);
        inStack.add(node);
        stack.push(node);

        const neighbors = graph.get(node);
        if (neighbors) {
          for (const [nextNode, edgeMeta] of neighbors.entries()) {
            if (!visited.has(nextNode)) {
              dfs(nextNode);
            } else if (inStack.has(nextNode)) {
              const cycleStartIndex = stack.indexOf(nextNode);
              if (cycleStartIndex !== -1) {
                const cycleNodes = stack.slice(cycleStartIndex);
                const sig = canonicalizeCycle(cycleNodes);
                const cycleEdges = cycleNodes.map((source, index) => graph.get(source)?.get(cycleNodes[(index + 1) % cycleNodes.length]));
                if (relevantFiles && !cycleEdges.some(edge => edge && [...edge.files].some(file => relevantFiles.has(file)))) continue;
                if (!reportedCycles.has(sig)) {
                  reportedCycles.add(sig);
                  const firstNode = cycleNodes[0];
                  const secondNode = cycleNodes[1] ?? nextNode;
                  const firstEdge = graph.get(firstNode)?.get(secondNode) ?? edgeMeta;
                  const cycleDisplay = [...cycleNodes, cycleNodes[0]].join(" -> ");
                  violations.push({
                    file: firstEdge.file,
                    line: firstEdge.line,
                    source_domain: firstEdge.source_domain,
                    target_domain: firstEdge.target_domain,
                    imported_target: firstEdge.target,
                    rule: "circular_dependency",
                    message: `Circular ${kindLabel} dependency detected: ${cycleDisplay}.`,
                  });
                }
              }
            }
          }
        }

        stack.pop();
        inStack.delete(node);
      };

      for (const startNode of graph.keys()) {
        if (!visited.has(startNode)) {
          dfs(startNode);
        }
      }
    };

    findCycles(fileGraph, "file");
    findCycles(domainGraph, "domain");

    return violations;
  }

  public checkProposedChanges(
    sourceFilePath: string,
    proposedImports: string[],
    config: ValidatedSeptumConfig
  ): BoundaryViolation[] {
    const violations: BoundaryViolation[] = [];
    const sourceDomain = this.resolveSourceDomain(sourceFilePath, config);

    if (!sourceDomain) {
      violations.push({
        file: sourceFilePath,
        line: 1,
        source_domain: "unmapped",
        target_domain: "unknown",
        imported_target: "",
        rule: "unmapped_domain",
        message: `File '${sourceFilePath}' does not belong to any declared bounded context. Boundary integrity cannot be enforced.`,
      });
      return violations;
    }

    const sourceDomainConfig = config.domains[sourceDomain];
    if (!sourceDomainConfig) {
      return violations;
    }

    const forbidden = sourceDomainConfig.forbidden_dependencies ?? [];
    const allowed = sourceDomainConfig.allowed_dependencies ?? [];

    for (const statement of proposedImports) {
      const targetDomain = this.resolveTargetDomain(statement, config, sourceFilePath);
      if (!targetDomain || targetDomain === sourceDomain) {
        continue;
      }

      if (forbidden.includes(targetDomain)) {
        violations.push({
          file: sourceFilePath,
          line: 1,
          source_domain: sourceDomain,
          target_domain: targetDomain,
          imported_target: statement,
          rule: "forbidden_dependency",
          message: `Illegal import blocked: Domain '${sourceDomain}' is strictly forbidden from importing domain '${targetDomain}'.`,
        });
      } else if (config.settings.enforcement === "strict" && !allowed.includes(targetDomain)) {
        violations.push({
          file: sourceFilePath,
          line: 1,
          source_domain: sourceDomain,
          target_domain: targetDomain,
          imported_target: statement,
          rule: "disallowed_dependency",
          message: `Unlisted domain dependency: '${targetDomain}' must be explicitly added to allowed_dependencies before domain '${sourceDomain}' can import it.`,
        });
      }
    }

    return violations;
  }

  public resolveSourceDomain(filePath: string, config: ValidatedSeptumConfig): string | null {
    return this.resolver.resolveSourceDomain(filePath, config);
  }

  public resolveTargetDomain(
    targetStatement: string,
    config: ValidatedSeptumConfig,
    sourceFilePath?: string
  ): string | null {
    return this.resolver.resolveTargetDomain(targetStatement, sourceFilePath, config);
  }

  public checkFeatureTouchpoints(
    featureKey: string,
    targetFilePath: string,
    config: ValidatedSeptumConfig
  ): BoundaryViolation[] {
    const violations: BoundaryViolation[] = [];
    const features = config.features ?? {};
    const featureConfig = features[featureKey];

    if (!featureConfig) {
      violations.push({
        file: targetFilePath,
        line: 1,
        source_domain: "unknown",
        target_domain: "unknown",
        imported_target: targetFilePath,
        rule: "unknown_feature",
        message: `Feature '${featureKey}' is not defined in septum configuration.`,
      });
      return violations;
    }

    const root = this.resolver.getProjectRoot();
    const normalizedTarget = relative(root, resolve(root, targetFilePath.replace(/\\/g, "/"))).replace(/\\/g, "/");
    const allowedTouchpoints = featureConfig.allowed_touchpoints.map((tp) =>
      isAbsolute(tp) ? relative(root, tp).replace(/\\/g, "/") : posix.normalize(tp.replace(/\\/g, "/"))
    );

    const domainCfg = config.domains[featureConfig.domain];
    const domainRoot = domainCfg?.root ? domainCfg.root.replace(/\\/g, "/").replace(/^\.\//, "") : "";

    const matches = (pattern: string): boolean => {
      if (normalizedTarget === pattern) return true;
      if (pattern.endsWith("/**")) {
        return normalizedTarget.startsWith(pattern.slice(0, -3) + "/");
      }
      if (pattern.endsWith("/*")) {
        const prefix = pattern.slice(0, -2) + "/";
        return normalizedTarget.startsWith(prefix) && !normalizedTarget.slice(prefix.length).includes("/");
      }
      return matchesSimpleGlob(normalizedTarget, pattern, false);
    };
    const isAllowed = allowedTouchpoints.some(pattern =>
      matches(pattern) || Boolean(domainRoot && matches(posix.normalize(`${domainRoot}/${pattern}`)))
    );

    if (!isAllowed) {
      violations.push({
        file: targetFilePath,
        line: 1,
        source_domain: featureConfig.domain,
        target_domain: "unknown",
        imported_target: targetFilePath,
        rule: "touchpoint_violation",
        message: `Scope violation: File '${targetFilePath}' is outside the declared allowed_touchpoints for feature '${featureKey}'. Permitted: [${allowedTouchpoints.join(", ")}].`,
      });
    }

    return violations;
  }
}
