import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { DomainToolArgs } from "../schemas.ts";
import { handleGetDomainCatalog } from "./get-domain-catalog.ts";
import { handleRegisterDomain } from "./register-domain.ts";
import { handleGetEnvironmentTopology } from "./get-environment-topology.ts";

export type { DomainToolArgs };

export async function handleDomainTool(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: DomainToolArgs,
  workspaceRoot?: string
) {
  const action = args.action || "catalog";

  switch (action) {
    case "register":
      return await handleRegisterDomain(repo, config, args, workspaceRoot);

    case "topology":
      return handleGetEnvironmentTopology(
        repo,
        config,
        {
          resolve: args.resolve,
          resolveNode: args.resolve_node,
          refresh: args.refresh,
          workspace_path: args.workspace_path,
        },
        workspaceRoot || args.workspace_path || process.cwd()
      );

    case "catalog":
    default:
      return handleGetDomainCatalog(repo, config, args, workspaceRoot);
  }
}
