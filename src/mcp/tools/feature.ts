import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import type { FeatureToolArgs } from "../schemas.ts";
import { handleGetFeatureContext, handleClearFeatureContext } from "./get-feature-context.ts";
import { handleRegisterFeature } from "./register-feature.ts";

export type { FeatureToolArgs };

export async function handleFeatureTool(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: FeatureToolArgs,
  workspaceRoot?: string
) {
  const action = args.action || "get";

  switch (action) {
    case "lock":
      return await handleRegisterFeature(
        repo,
        config,
        {
          feature_key: args.feature_key || args.feature || "",
          feature: args.feature || args.feature_key || "",
          domain: args.domain || args.domain_name || "",
          domain_name: args.domain_name || args.domain || "",
          description: args.description,
          allowed_touchpoints: args.allowed_touchpoints,
          reuse_symbols: args.reuse_symbols,
          input_contract: args.input_contract,
          output_contract: args.output_contract,
          workspace_path: args.workspace_path,
        },
        workspaceRoot || args.workspace_path || process.cwd()
      );

    case "release": {
      const cleared = handleClearFeatureContext(workspaceRoot || args.workspace_path || process.cwd());
      return {
        content: [
          {
            type: "text" as const,
            text: cleared
              ? "Active feature session successfully released."
              : "No active feature session found to release.",
          },
        ],
      };
    }

    case "get":
    default:
      return handleGetFeatureContext(
        repo,
        config,
        {
          feature_key: args.feature_key || args.feature,
          feature: args.feature || args.feature_key,
          workspace_path: args.workspace_path,
        },
        workspaceRoot || args.workspace_path || process.cwd()
      );
  }
}
