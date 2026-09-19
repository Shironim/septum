import type { BoundaryViolation } from "../../types/index.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import { ConfigLoader } from "../config/loader.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { ModuleResolver } from "../resolver/module-resolver.ts";

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
    const activeConfig = config ?? ConfigLoader.loadFromDatabaseOrDefaults();
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

    for (const dep of allDependencies) {
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

    const normalizedTarget = targetFilePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const allowedTouchpoints = featureConfig.allowed_touchpoints.map((tp) =>
      tp.replace(/\\/g, "/").replace(/^\.\//, "")
    );

    const isAllowed = allowedTouchpoints.some((pattern) => {
      if (pattern.endsWith("/**")) {
        const prefix = pattern.slice(0, -3);
        return normalizedTarget.startsWith(prefix);
      }
      if (pattern.endsWith("/*")) {
        const prefix = pattern.slice(0, -2);
        return normalizedTarget.startsWith(prefix);
      }
      return (
        normalizedTarget === pattern ||
        normalizedTarget.endsWith("/" + pattern) ||
        pattern.endsWith("/" + normalizedTarget)
      );
    });

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
