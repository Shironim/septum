import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { SessionManager } from "../../core/session/session-manager.ts";
import type { FeatureContextResponse } from "../../types/index.ts";

export interface GetFeatureContextArgs {
  feature: string;
}

export function handleClearFeatureContext(workspaceRoot: string = process.cwd()): boolean {
  return SessionManager.clearActiveSession(workspaceRoot);
}

export function handleGetFeatureContext(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: GetFeatureContextArgs
) {
  if (!args.feature) {
    throw new Error("Missing required argument: 'feature'");
  }

  const features = config.features ?? {};
  const featureConfig = features[args.feature];

  if (!featureConfig) {
    const available = Object.keys(features).join(", ") || "none";
    throw new Error(
      `Feature '${args.feature}' not found in configuration. Available features: [${available}]`
    );
  }

  // Record Active Feature Session Lease (.septum/session.json)
  SessionManager.saveActiveSession(process.cwd(), {
    feature_key: args.feature,
    domain: featureConfig.domain,
    touchpoints: featureConfig.allowed_touchpoints ?? [],
    locked_at: new Date().toISOString(),
  });

  // Deterministically fetch signatures, methods, and properties for reuse_symbols from SQLite
  const reuseSymbolsWithMeta: FeatureContextResponse["reuse_symbols"] = [];
  const requestedSymbols = featureConfig.reuse_symbols ?? [];

  for (const symName of requestedSymbols) {
    const record = repo.findSymbolWithMembers(symName);
    if (record) {
      reuseSymbolsWithMeta.push({
        name: record.symbol_name,
        kind: record.kind,
        signature: record.signature,
        methods: record.methods.length > 0 ? record.methods : undefined,
        properties: record.properties.length > 0 ? record.properties : undefined,
        file_path: record.file_path,
        domain: record.domain_name,
      });
    } else {
      reuseSymbolsWithMeta.push({
        name: symName,
        kind: "unknown",
        domain: featureConfig.domain,
      });
    }
  }

  const response: FeatureContextResponse = {
    feature: args.feature,
    domain: featureConfig.domain,
    description: featureConfig.description,
    allowed_touchpoints: featureConfig.allowed_touchpoints,
    reuse_symbols: reuseSymbolsWithMeta,
    input_contract: (featureConfig.input_contract as Record<string, unknown>) ?? {},
    output_contract: (featureConfig.output_contract as Record<string, unknown>) ?? {},
    governance_directives: [
      "DO NOT modify or edit any files outside allowed_touchpoints.",
      "DO NOT create duplicate helpers/services; reuse the existing symbols and methods declared in reuse_symbols.",
      "DO NOT emit or expect phantom payload fields outside input_contract and output_contract.",
      "DO NOT import cross-domain modules without declared allowed_dependencies in Septum domain boundaries.",
    ],
  };

  recordFeatureAccess(featureConfig.domain, args.feature);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(response, null, 2),
      },
    ],
  };
}

function recordFeatureAccess(domain: string, feature: string): void {
  try {
    const septumDir = path.resolve(process.cwd(), ".septum");
    if (!fs.existsSync(septumDir)) {
      fs.mkdirSync(septumDir, { recursive: true });
    }
    const logPath = path.join(septumDir, "catalog_access.json");
    let log: { domains?: Record<string, string>; features?: Record<string, string> } = {};
    if (fs.existsSync(logPath)) {
      try {
        log = JSON.parse(fs.readFileSync(logPath, "utf-8"));
      } catch {}
    }
    log.domains = log.domains || {};
    log.features = log.features || {};
    const now = new Date().toISOString();
    log.domains[domain] = now;
    log.features[feature] = now;
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf-8");
  } catch {}
}
