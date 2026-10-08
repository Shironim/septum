import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { IngestionPipeline, type IngestionMetrics } from "../../core/ingestion/pipeline.ts";
import type { DomainConfig } from "../../types/index.ts";

export interface RegisterDomainArgs {
  domain?: string;
  name?: string;
  root: string;
  description?: string;
  allowed_dependencies?: string[];
  forbidden_dependencies?: string[];
  archetypes?: Record<string, string>;
  ingest_now?: boolean;
}

export async function handleRegisterDomain(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: RegisterDomainArgs,
  workspaceRoot: string = process.cwd()
) {
  const domainName = (args.domain || args.name || "").trim();
  if (!domainName || !args.root) {
    throw new Error("Missing required arguments: 'domain' (or 'name') and 'root' are required.");
  }

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
