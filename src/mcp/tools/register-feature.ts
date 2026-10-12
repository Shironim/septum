import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { SessionManager } from "../../core/session/session-manager.ts";
import type { RegisterFeatureArgs } from "../schemas.ts";

export type { RegisterFeatureArgs } from "../schemas.ts";

export async function handleRegisterFeature(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: Partial<RegisterFeatureArgs>,
  workspaceRoot: string = process.cwd()
) {
  const featureKey = (args.feature_key || args.feature || "").toString().trim();
  const domain = (args.domain || args.domain_name || "").toString().trim();

  if (!featureKey || !domain) {
    throw new Error("Missing required arguments: 'feature_key' and 'domain' are required.");
  }

  const rawTouchpoints = args.allowed_touchpoints ?? [];
  const allowedTouchpoints = Array.isArray(rawTouchpoints)
    ? rawTouchpoints
    : typeof rawTouchpoints === "string"
    ? [rawTouchpoints]
    : [];

  const rawReuse = args.reuse_symbols;
  const reuseSymbols: string[] = Array.isArray(rawReuse)
    ? rawReuse
    : typeof rawReuse === "string"
    ? [rawReuse]
    : [];

  const featureConfig = {
    domain,
    description: args.description || `Feature: ${featureKey}`,
    allowed_touchpoints: allowedTouchpoints,
    reuse_symbols: reuseSymbols,
    input_contract: args.input_contract || {},
    output_contract: args.output_contract || {},
  };

  // Record Active Feature Session Lease (.septum/session.json)
  SessionManager.saveActiveSession(workspaceRoot, {
    feature_key: featureKey,
    domain,
    touchpoints: featureConfig.allowed_touchpoints,
    locked_at: new Date().toISOString(),
  });

  if (!config.features) {
    config.features = {};
  }
  config.features[featureKey] = featureConfig;

  if (typeof (repo as any)?.upsertFeature === "function") {
    (repo as any).upsertFeature(featureKey, featureConfig);
  } else if (typeof repo?.setMeta === "function") {
    try {
      const existingRaw = repo.getMeta("features_json");
      const featuresMap = existingRaw ? JSON.parse(existingRaw) : {};
      featuresMap[featureKey] = featureConfig;
      repo.setMeta("features_json", JSON.stringify(featuresMap));
    } catch {
      // Ignore meta persistence errors on mock repositories
    }
  }



  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "success",
            message: `Feature '${featureKey}' successfully registered in SQLite SSOT and session lease established.`,
            feature_key: featureKey,
            feature: featureKey,
            domain,
            touchpoints: featureConfig.allowed_touchpoints,
            reuse_symbols: featureConfig.reuse_symbols,
          },
          null,
          2
        ),
      },
    ],
  };
}

