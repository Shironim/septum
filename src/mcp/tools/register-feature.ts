import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { SessionManager } from "../../core/session/session-manager.ts";
import type { FeatureConfig, RegisterFeatureArgs } from "../../types/index.ts";

export async function handleRegisterFeature(
  _repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: RegisterFeatureArgs,
  workspaceRoot: string = process.cwd()
) {
  const featureKey = (args.feature_key || (args as unknown as Record<string, unknown>).feature || "").toString().trim();
  const domain = (args.domain || (args as unknown as Record<string, unknown>).domain_name || "").toString().trim();

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

  if (!config.features) {
    config.features = {};
  }
  config.features[featureKey] = featureConfig;

  // Record Active Feature Session Lease (.septum/session.json)
  SessionManager.saveActiveSession(workspaceRoot, {
    feature_key: featureKey,
    domain,
    touchpoints: featureConfig.allowed_touchpoints,
    locked_at: new Date().toISOString(),
  });

  let persisted = false;
  if (args.persist_to_config) {
    try {
      const configPath = path.resolve(workspaceRoot, "septum.config.json");
      let diskConfig: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        diskConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      }
      if (!diskConfig.features || typeof diskConfig.features !== "object") {
        diskConfig.features = {};
      }
      (diskConfig.features as Record<string, unknown>)[featureKey] = featureConfig;
      fs.writeFileSync(configPath, JSON.stringify(diskConfig, null, 2), "utf-8");
      persisted = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Septum Warning] Failed to persist feature to septum.config.json: ${msg}`);
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            status: "success",
            message: `Feature '${featureKey}' successfully registered and session lease established.${
              persisted ? " Persisted to septum.config.json." : ""
            }`,
            feature_key: featureKey,
            feature: featureKey,
            domain,
            touchpoints: featureConfig.allowed_touchpoints,
            reuse_symbols: featureConfig.reuse_symbols,
            persisted_to_disk: persisted,
          },
          null,
          2
        ),
      },
    ],
  };
}
