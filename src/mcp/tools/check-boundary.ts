import { assertPathContained } from "../../core/resolver/path-resolver.ts";
import { readSourceFile } from "../../core/resources/source-files.ts";
import { computeContentHash } from "../../core/ingestion/hasher.ts";
import { relative, resolve } from "node:path";
import { auditStagedFiles } from "../../core/boundary/staged-auditor.ts";
import type { BoundaryEvaluator } from "../../core/boundary/evaluator.ts";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { SessionManager } from "../../core/session/session-manager.ts";
import type { BoundaryViolation } from "../../types/index.ts";
import { CheckBoundarySchema, type CheckBoundaryArgs } from "../schemas.ts";

export type { CheckBoundaryArgs } from "../schemas.ts";

export async function handleCheckBoundary(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  rawArgs: CheckBoundaryArgs & Record<string, unknown>,
  repo?: SeptumRepository,
  workspaceRoot?: string
) {
  const args = CheckBoundarySchema.parse(rawArgs ?? {});
  if (args.domain) {
    const domain = Object.keys(config.domains || {}).find(name => name.toLowerCase() === args.domain!.toLowerCase());
    if (!domain) throw new Error(`Unknown boundary domain '${args.domain}'. Choose a registered domain.`);
    args.domain = domain;
  }
  const root = workspaceRoot || args.workspace_path || process.cwd();
  const proposedImports = args.proposed_imports ?? [];

  const activeSession = SessionManager.getActiveSession(root);

  let effectiveFeatureKey = args.feature_key;
  if (activeSession) {
    if (args.feature_key && args.feature_key !== activeSession.feature_key) {
      throw new Error(
        `Active feature lock is '${activeSession.feature_key}' (owner: ${activeSession.owner_id}). Cannot check boundaries for different feature '${args.feature_key}' while another feature is locked.`
      );
    }
    effectiveFeatureKey = activeSession.feature_key;
    if (!config.features) config.features = {};
    if (!config.features[activeSession.feature_key]) {
      config.features[activeSession.feature_key] = {
        domain: activeSession.domain,
        description: `Active session: ${activeSession.feature_key}`,
        allowed_touchpoints: activeSession.touchpoints,
        reuse_symbols: [],
        input_contract: {},
        output_contract: {},
      };
    }
  }

  const syncState = repo?.getMeta("sync_state");
  const syncError = repo?.getMeta("sync_error");
  if (!syncState || syncState === "running" || syncState === "error" || syncState !== "complete" || syncError) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "unknown",
            sync_state: syncState || "unindexed",
            sync_error: syncError || undefined,
            message: "Boundary audit is incomplete because workspace synchronization has not completed.",
          }),
        },
      ],
    };
  }
  const skipped = JSON.parse(repo?.getMeta("skipped_files") || "[]") as {path: string; reason: string}[];
  const unsupported = JSON.parse(repo?.getMeta("unsupported_files") || "[]") as string[];
  const requested = [...(Array.isArray(args.file_path) ? args.file_path : args.file_path ? [args.file_path] : []), ...(args.file_paths || [])]
    .map(file => relative(root, resolve(root, file)).replace(/\\/g, "/"));
  const relevantUnsupported = unsupported.filter(file =>
    (!args.domain || evaluator.resolveSourceDomain(file, config) === args.domain) &&
    (requested.length === 0 || requested.includes(file))
  );
  const relevantSkipped = skipped.filter(file =>
    (!args.domain || evaluator.resolveSourceDomain(file.path, config) === args.domain) &&
    (requested.length === 0 || requested.includes(file.path))
  );
  if (relevantSkipped.length > 0 && args.scope !== "staged" && !args.staged) {
    return { content: [{type: "text" as const, text: JSON.stringify({status: "unknown", skipped_files: relevantSkipped, message: "Boundary audit is incomplete because source files exceed resource limits."})}] };
  }
  if (relevantUnsupported.length > 0 && args.scope !== "staged" && !args.staged) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ status: "unknown", unsupported_files: relevantUnsupported, message: "Boundary audit is incomplete because source files have no supported parser." }) }] };
  }

  if (args.scope !== "staged" && !args.staged && repo) {
    const relevant = (file: string) => (!args.domain || evaluator.resolveSourceDomain(file,config) === args.domain) && (requested.length === 0 || requested.includes(file));
    const staleFiles = repo.getMeta("workspace_root") ? repo.getAllFiles().filter(file => relevant(file.path)).filter(file => {
      try { assertPathContained(file.path,root,"Boundary source"); return computeContentHash(readSourceFile(resolve(root,file.path))) !== file.content_hash; }
      catch { return true; }
    }).map(file => file.path) : [];
    const relationships = repo.getImportRelationships(root).filter(edge => relevant(edge.source.file));
    const incomplete = relationships.filter(edge => edge.index_coverage === "partial" || edge.freshness !== "current" || !["resolved","external"].includes(edge.resolution.status) || edge.resolution.coverage === "conditional" || edge.target_domains.length > 1);
    const proposed = requested.flatMap(file => proposedImports.map(target => evaluator.getResolver().resolveImport(target,file)))
      .filter(result => !["resolved","external"].includes(result.status) || result.coverage === "conditional");
    if (incomplete.length || proposed.length || staleFiles.length) {
      const known = evaluator.auditCodebase(config).filter(violation => relevant(violation.file));
      known.push(...requested.flatMap(file => evaluator.evaluate(file,proposedImports,effectiveFeatureKey,config)));
      return { content: [{ type: "text" as const, text: JSON.stringify({
        status: known.length ? "rejected" : "unknown", violations: known, total_violations: known.length,
        circular_dependencies: known.filter(v => v.rule === "circular_dependency"), circular_dependencies_count: known.filter(v => v.rule === "circular_dependency").length, relationships: incomplete, proposed_resolutions: proposed,
        stale_files: staleFiles,
        message: "Relevant import resolution is incomplete; an empty graph cannot prove boundary approval.",
      }) }] };
    }
  }

  const filesToCheck: string[] = [];
  if (args.file_paths && Array.isArray(args.file_paths) && args.file_paths.length > 0) {
    filesToCheck.push(...args.file_paths);
  } else if (args.file_path) {
    if (Array.isArray(args.file_path)) {
      filesToCheck.push(...args.file_path);
    } else if (typeof args.file_path === "string" && args.file_path.trim().length > 0) {
      filesToCheck.push(args.file_path.trim());
    }
  }

  // Repo-wide, domain-scoped, or git-staged boundary audit when neither file_path nor file_paths is provided
  if (filesToCheck.length === 0) {
    const effectiveScope =
      args.scope ?? (args.staged ? "staged" : args.domain ? "domain" : "all");

    if (effectiveScope === "staged") {
      const { files: stagedFiles, violations: stagedViolations, resolution_issues: resolutionIssues } = await auditStagedFiles(evaluator, config, root, effectiveFeatureKey, repo);

      if (stagedFiles.length === 0 && stagedViolations.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "approved",
                  scope: "staged",
                  total_checked: 0,
                  total_violations: 0,
                  circular_dependencies: [],
                  domain_violation_breakdown: {},
                  violations: [],
                  message: "No git staged files found. Boundary check passed.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const filteredViolations = args.domain
        ? stagedViolations.filter(
            (v) =>
              v.source_domain.toLowerCase() === args.domain!.toLowerCase() ||
              v.target_domain.toLowerCase() === args.domain!.toLowerCase()
          )
        : stagedViolations;

      const circularDependencies = filteredViolations.filter((v) => v.rule === "circular_dependency");
      const domainBreakdown: Record<string, number> = {};
      for (const v of filteredViolations) {
        const pair = `${v.source_domain} -> ${v.target_domain}`;
        domainBreakdown[pair] = (domainBreakdown[pair] || 0) + 1;
      }

      const hasViolations = filteredViolations.length > 0;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: hasViolations ? "rejected" : resolutionIssues.length ? "unknown" : "approved",
                resolution_issues: resolutionIssues,
                scope: "staged",
                total_checked: stagedFiles.length,
                total_violations: filteredViolations.length,
                circular_dependencies_count: circularDependencies.length,
                circular_dependencies: circularDependencies,
                domain_violation_breakdown: domainBreakdown,
                violations: filteredViolations,
                message: resolutionIssues.length && !hasViolations ? "Staged import resolution is incomplete; approval is unknown." : hasViolations
                  ? `${filteredViolations.length} boundary violation(s) detected across ${stagedFiles.length} staged file(s).`
                  : `All ${stagedFiles.length} staged file(s) approved. No boundary violations detected.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Scope: "all" or "domain"
    if (args.feature_key) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "rejected",
                scope: effectiveScope,
                message: `Scope '${effectiveScope}' is an architectural audit across domains and does not support feature touchpoint validation ('feature_key'). Feature scopes only apply to 'file', 'batch', or 'staged'.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    let violations = evaluator.auditCodebase(config);
    if (args.domain) {
      const targetDom = args.domain.toLowerCase();
      violations = violations.filter(
        (v) =>
          v.source_domain.toLowerCase() === targetDom ||
          v.target_domain.toLowerCase() === targetDom
      );
    }

    const circularDependencies = violations.filter((v) => v.rule === "circular_dependency");
    const domainBreakdown: Record<string, number> = {};
    for (const v of violations) {
      const pair = `${v.source_domain} -> ${v.target_domain}`;
      domainBreakdown[pair] = (domainBreakdown[pair] || 0) + 1;
    }

    const hasViolations = violations.length > 0;
    const domainCount = Object.keys(config?.domains || {}).length;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: hasViolations ? "rejected" : "approved",
              scope: args.domain ? "domain" : "all",
              ...(args.domain ? { domain: args.domain } : {}),
              total_domains_checked: domainCount,
              total_violations: violations.length,
              circular_dependencies_count: circularDependencies.length,
              circular_dependencies: circularDependencies,
              domain_violation_breakdown: domainBreakdown,
              violations,
              message: hasViolations
                ? `${violations.length} boundary violation(s) (${circularDependencies.length} circular) detected${
                    args.domain ? ` in domain '${args.domain}'` : " across codebase"
                  }.`
                : domainCount === 0
                ? "No boundary violations detected. [Septum Notice: Domain catalog is currently unindexed. Run 'septum_domain' with action='register' to initialize bounded contexts.]"
                : `All domain boundaries are clean${
                    args.domain ? ` for domain '${args.domain}'` : ""
                  }. Zero cross-domain leaks or circular dependencies detected.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Multi-file batch evaluation
  if (filesToCheck.length > 1) {
    const results = filesToCheck.map((filePath) => {
      const violations = evaluator.evaluate(filePath, proposedImports, effectiveFeatureKey, config);
      const impact = repo?.getFileInboundImpact(filePath);
      return {
        file: filePath,
        status: violations.length > 0 ? "rejected" : "approved",
        violations,
        impact_summary: impact
          ? {
              direct_dependents: impact.direct_dependents_count,
              top_consumers: impact.top_consumers,
              symbols_count: impact.symbols_count,
              risk_level: impact.risk_level,
            }
          : undefined,
      };
    });

    const totalViolations = results.reduce((acc, r) => acc + r.violations.length, 0);
    const hasViolations = totalViolations > 0;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: hasViolations ? "rejected" : "approved",
              total_checked: filesToCheck.length,
              total_violations: totalViolations,
              results,
              message: hasViolations
                ? `${totalViolations} boundary violation(s) detected across ${filesToCheck.length} file(s).`
                : Object.keys(config?.domains || {}).length === 0
                ? `All ${filesToCheck.length} file(s) approved. [Septum Notice: Domain catalog is currently unindexed. Run 'septum_domain' with action='register' to initialize bounded contexts.]`
                : `All ${filesToCheck.length} file(s) approved. No boundary violations detected.`,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Single file evaluation (backward-compatible output)
  const singleFile = filesToCheck[0];
  const violations = evaluator.evaluate(singleFile, proposedImports, effectiveFeatureKey, config);
  const impact = repo?.getFileInboundImpact(singleFile);

  if (violations.length > 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "rejected",
              file: singleFile,
              violations_count: violations.length,
              violations,
              impact_summary: impact
                ? {
                    direct_dependents: impact.direct_dependents_count,
                    top_consumers: impact.top_consumers,
                    symbols_count: impact.symbols_count,
                    risk_level: impact.risk_level,
                  }
                : undefined,
              message:
                Object.keys(config?.domains || {}).length === 0
                  ? "Boundary integrity check failed: Domain catalog is currently unindexed. Run 'septum_domain' with action='register' to initialize bounded contexts."
                  : violations.some((v) => v.rule === "unmapped_domain")
                  ? "Boundary integrity check failed: File does not belong to any declared bounded context."
                  : "Boundary violation detected. Proposed imports violate bounded context architecture.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "approved",
            file: singleFile,
            impact_summary: impact
              ? {
                  direct_dependents: impact.direct_dependents_count,
                  top_consumers: impact.top_consumers,
                  symbols_count: impact.symbols_count,
                  risk_level: impact.risk_level,
                }
              : undefined,
            message:
              Object.keys(config?.domains || {}).length === 0
                ? "No boundary violations detected. [Septum Notice: Domain catalog is currently unindexed. Run 'septum_domain' with action='register' to initialize bounded contexts.]"
                : impact && impact.direct_dependents_count > 0
                ? `No boundary violations detected. Caution: ${impact.direct_dependents_count} dependent file(s) consume this file.`
                : "No boundary violations detected. Proposed imports are permissible.",
          },
          null,
          2
        ),
      },
    ],
  };
}

