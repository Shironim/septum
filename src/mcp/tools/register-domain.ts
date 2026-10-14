import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { IngestionPipeline, type IngestionMetrics } from "../../core/ingestion/pipeline.ts";
import { assertPathContained } from "../../core/resolver/path-resolver.ts";
import type { RegisterDomainArgs } from "../schemas.ts";

export type { RegisterDomainArgs } from "../schemas.ts";

export async function handleRegisterDomain(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: Partial<RegisterDomainArgs>,
  workspaceRoot: string = process.cwd(),
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const domainName = (args.domain || args.name || "").trim();
  if (!domainName || !args.root) {
    throw new Error("Missing required arguments: 'domain' (or 'name') and 'root' are required.");
  }

  // SV-02: Enforce workspace containment (reject traversal/absolute/symlink escape)
  assertPathContained(args.root, workspaceRoot, "Domain root");
  signal?.throwIfAborted();

  const domainConfig = {
    root: args.root,
    description: args.description || `Domain: ${domainName}`,
    allowed_dependencies: args.allowed_dependencies || [],
    forbidden_dependencies: args.forbidden_dependencies || [],
    archetypes: args.archetypes || {},
  };

  const domainId = repo.domains.upsertDomain(domainName, domainConfig);

  config.domains[domainName] = domainConfig;

  let ingestionMetrics: IngestionMetrics | null = null;
  if (args.ingest_now) {
    const pipeline = new IngestionPipeline(repo, workspaceRoot);
    ingestionMetrics = await pipeline.run(config);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "success",
            message: `Domain '${domainName}' successfully registered in SQLite SSOT.${
              args.ingest_now ? " Initial ingestion completed." : ""
            }`,
            domain_id: domainId,
            domain: domainName,
            name: domainName,
            config: domainConfig,
            ...(ingestionMetrics ? { ingestion_metrics: ingestionMetrics } : {}),
          },
          null,
          2
        ),
      },
    ],
  };
}
