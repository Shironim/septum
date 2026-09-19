import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { IngestionPipeline, type IngestionMetrics } from "../../core/ingestion/pipeline.ts";
import type { DomainConfig } from "../../types/index.ts";

export interface RegisterDomainArgs {
  name: string;
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
  args: RegisterDomainArgs
) {
  if (!args.name || !args.root) {
    throw new Error("Missing required arguments: 'name' and 'root' are required.");
  }

  const domainConfig: DomainConfig = {
    root: args.root,
    description: args.description || `Domain: ${args.name}`,
    allowed_dependencies: args.allowed_dependencies || [],
    forbidden_dependencies: args.forbidden_dependencies || [],
    archetypes: args.archetypes || {},
  };

  const domainId = repo.domains.upsertDomain(args.name, domainConfig);

  config.domains[args.name] = domainConfig;

  let ingestionMetrics: IngestionMetrics | null = null;
  if (args.ingest_now) {
    const pipeline = new IngestionPipeline(repo);
    ingestionMetrics = await pipeline.run(config);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "success",
            message: `Domain '${args.name}' successfully registered in SQLite SSOT.${
              args.ingest_now ? " Initial ingestion completed." : ""
            }`,
            domain_id: domainId,
            domain: args.name,
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
