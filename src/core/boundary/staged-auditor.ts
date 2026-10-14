import { RESOURCE_LIMITS } from "../resources/limits.ts";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { BoundaryViolation } from "../../types/index.ts";
import type { ValidatedSeptumConfig } from "../config/schema.ts";
import { ASTParserEngine } from "../parser/tree-sitter.ts";
import type { SeptumRepository } from "../database/repository.ts";
import type { BoundaryEvaluator } from "./evaluator.ts";

export async function auditStagedFiles(
  evaluator: BoundaryEvaluator,
  config: ValidatedSeptumConfig,
  workspaceRoot: string,
  featureKey?: string,
  repo?: SeptumRepository
): Promise<{ files: string[]; violations: BoundaryViolation[] }> {
  const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
    cwd: workspaceRoot, encoding: "utf-8", timeout: 5000, maxBuffer: 10 * 1024 * 1024,
  });
  const files = output.split("\0").filter(Boolean);
  const deletedOutput = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=D", "-z"], {
    cwd: workspaceRoot, encoding: "utf-8", timeout: 5000, maxBuffer: 10 * 1024 * 1024,
  });
  const deleted = deletedOutput.split("\0").filter(Boolean);
  const violations: BoundaryViolation[] = [];
  if (featureKey) for (const file of deleted) violations.push(...evaluator.checkFeatureTouchpoints(featureKey, file, config));
  const stagedDependencies: ReturnType<SeptumRepository["getAllDependenciesWithDomains"]> = [];
  const parser = new ASTParserEngine();
  for (const file of files) {
    if (featureKey) violations.push(...evaluator.checkFeatureTouchpoints(featureKey, file, config));
    if (!ASTParserEngine.isSourceFile(file) || !evaluator.resolveSourceDomain(file, config)) continue;
    const size = Number(execFileSync("git", ["cat-file", "-s", `:${file}`], {cwd:workspaceRoot,encoding:"utf8",timeout:5000,maxBuffer:1024}));
    if (!Number.isFinite(size) || size > RESOURCE_LIMITS.sourceBytes) throw new Error(`Staged source exceeds resource limit: '${file}'.`);
    const content = execFileSync("git", ["show", `:${file}`], {
      cwd: workspaceRoot, encoding: "utf-8", timeout: 5000, maxBuffer: RESOURCE_LIMITS.sourceBytes + 1,
    });
    const parsed = await parser.parseFile(resolve(workspaceRoot, file), content);
    if (parsed.status === "unsupported" || parsed.status === "degraded") {
      throw new Error(`Cannot reliably parse staged file '${file}': ${parsed.status}.`);
    }
    for (const dependency of parsed.dependencies) {
      stagedDependencies.push({ source_file: file, source_domain: evaluator.resolveSourceDomain(file, config)!, target: dependency.target, statement: dependency.statement, line_number: dependency.line_number, is_external: dependency.is_external });
      violations.push(...evaluator.checkProposedChanges(file, [dependency.target], config).map(violation => ({ ...violation, line: dependency.line_number })));
    }
  }
  const staged = new Set([...files, ...deleted]);
  const baseline = (repo?.getAllDependenciesWithDomains() || []).filter(dependency => !staged.has(dependency.source_file));
  violations.push(...evaluator.detectCircularDependencies(config, [...baseline, ...stagedDependencies], staged));
  return { files, violations };
}
