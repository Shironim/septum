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

  // MCP-15: Validate domain is registered in DB or config
  const registeredDomain = repo.getDomainByName(domain);
  const configDomain = Object.keys(config.domains || {}).find(
    (d) => d.toLowerCase() === domain.toLowerCase()
  );
  if (!registeredDomain && !configDomain) {
    throw new Error(`Domain '${domain}' is not registered. Cannot lock feature to an unknown domain.`);
  }
  const canonicalDomain = registeredDomain?.name || configDomain || domain;

  const rawTouchpoints = args.allowed_touchpoints ?? [];
  const allowedTouchpoints = Array.isArray(rawTouchpoints)
    ? rawTouchpoints
    : typeof rawTouchpoints === "string"
    ? [rawTouchpoints]
    : [];

  // MCP-15: Validate supported touchpoint glob patterns (exact, /*, /**)
  for (const tp of allowedTouchpoints) {
    const normalized = tp.replace(/\\/g, "/");
    if (normalized.includes("*")) {
      if (!normalized.endsWith("/*") && !normalized.endsWith("/**") && normalized !== "*" && normalized !== "**") {
        throw new Error(
          `Unsupported touchpoint glob pattern '${tp}'. Septum touchpoints support exact paths, '/*', and '/**'.`
        );
      }
    }
  }

  const rawReuse = args.reuse_symbols;
  const reuseSymbols: string[] = Array.isArray(rawReuse)
    ? rawReuse
    : typeof rawReuse === "string"
    ? [rawReuse]
    : [];

  const featureConfig = {
    domain: canonicalDomain,
    description: args.description || `Feature: ${featureKey}`,
    allowed_touchpoints: allowedTouchpoints,
    reuse_symbols: reuseSymbols,
    input_contract: args.input_contract || {},
    output_contract: args.output_contract || {},
  };

  SessionManager.saveActiveSession(workspaceRoot, {
    feature_key: featureKey,
    domain: canonicalDomain,
    touchpoints: featureConfig.allowed_touchpoints,
    locked_at: new Date().toISOString(),
  }, SessionManager.getOwnerId(), {
    repo,
    save: () => {
      const existingRaw = repo.getMeta("features_json");
      const featuresMap = existingRaw ? JSON.parse(existingRaw) : {};
      featuresMap[featureKey] = featureConfig;
      repo.setMeta("features_json", JSON.stringify(featuresMap));
    },
  });

  // 3. Update in-memory config only after both SQLite and session lease succeeded
  if (!config.features) {
    config.features = {};
  }
  config.features[featureKey] = featureConfig;



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
            domain: canonicalDomain,
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

