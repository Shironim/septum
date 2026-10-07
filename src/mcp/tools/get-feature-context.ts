import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { SessionManager } from "../../core/session/session-manager.ts";
import type { FeatureContextResponse } from "../../types/index.ts";

export interface GetFeatureContextArgs {
  feature_key?: string;
  feature?: string;
  workspace_path?: string;
}

export function handleClearFeatureContext(workspaceRoot: string = process.cwd()): boolean {
  return SessionManager.clearActiveSession(workspaceRoot);
}

export function handleGetFeatureContext(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: GetFeatureContextArgs,
  workspaceRoot: string = process.cwd()
) {
  const featureKey = (args.feature_key || args.feature || "").trim();
  const features = config.features ?? {};

  // ZERO-ARGUMENT GRACEFUL FALLBACK: Guide the agent instead of throwing validation errors
  if (!featureKey) {
    const available = Object.keys(features);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "prompt",
              message: "No feature specified. Please specify 'feature_key' from the registered features below or trace routes.",
              available_features: available.length > 0 ? available : [],
              instructions: "Call 'septum_get_feature_context({ feature_key: \"<name>\" })' or register a new feature with 'septum_register_feature'.",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  let featureConfig = features[featureKey];
  let isInferred = false;

  if (!featureConfig) {
    // Attempt auto-derive from vertical slices or domain symbols
    const searchTerm = featureKey.toLowerCase();
    const allSlices = typeof repo.getAllVerticalSlices === "function" ? repo.getAllVerticalSlices() : [];
    const fromRepoSearch = typeof repo.findVerticalSlices === "function" ? repo.findVerticalSlices(searchTerm) : [];
    const matchingSlices = [
      ...fromRepoSearch,
      ...allSlices.filter(
        (s) =>
          s.route_uri.toLowerCase().includes(searchTerm) ||
          (s.route_name && s.route_name.toLowerCase().includes(searchTerm)) ||
          s.controller_class.toLowerCase().includes(searchTerm) ||
          (s.feature_key && s.feature_key.toLowerCase().includes(searchTerm))
      ),
    ];

    const uniqueSlices = Array.from(
      new Map(matchingSlices.map((s) => [`${s.http_method}:${s.route_uri}`, s])).values()
    );

    if (uniqueSlices.length > 0) {
      isInferred = true;
      const candidateTouchpoints = new Set<string>();
      const candidateSymbols = new Set<string>();
      let detectedDomain = "app";

      if (config.domains && config.domains[featureKey]) {
        detectedDomain = featureKey;
      }

      for (const slice of uniqueSlices) {
        if (slice.controller_file) {
          candidateTouchpoints.add(slice.controller_file);
        }
        candidateSymbols.add(slice.controller_class);
        if (slice.action_name) {
          candidateSymbols.add(`${slice.controller_class}@${slice.action_name}`);
        }

        if (slice.execution_chain_json) {
          try {
            const chain = JSON.parse(slice.execution_chain_json);
            if (Array.isArray(chain)) {
              for (const node of chain) {
                if (node.file) candidateTouchpoints.add(node.file);
                if (node.symbol) candidateSymbols.add(node.symbol);
              }
            }
          } catch {}
        }
      }

      featureConfig = {
        domain: detectedDomain,
        description: `[Auto-Derived] Feature context inferred from ${uniqueSlices.length} vertical slices matching '${featureKey}'`,
        allowed_touchpoints: Array.from(candidateTouchpoints),
        reuse_symbols: Array.from(candidateSymbols).slice(0, 10),
        input_contract: {},
        output_contract: {},
      };
    } else {
      const available = Object.keys(features);
      const availableStr = available.length > 0 ? available.join(", ") : "none";
      const recoveryMessage = [
        `Feature '${featureKey}' not found in configuration. Available features: [${availableStr}].`,
        `No matching vertical slices found for auto-derivation.`,
        ``,
        `▶ RECOVERY OPTIONS:`,
        `1. Register this feature on-the-fly:`,
        `   septum_register_feature({ feature_key: "${featureKey}", domain: "<domain_name>", allowed_touchpoints: ["path/to/file"] })`,
        `2. Or discover available routes / vertical slices first:`,
        `   septum_trace_vertical_slice({ entry_file: "routes/web.php" })`,
      ].join("\n");
      throw new Error(recoveryMessage);
    }
  }

  // Record Active Feature Session Lease (.septum/session.json)
  SessionManager.saveActiveSession(workspaceRoot, {
    feature_key: featureKey,
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
    feature_key: featureKey,
    feature: featureKey,
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
    ...(isInferred ? { is_inferred: true } : {}),
  };

  recordFeatureAccess(featureConfig.domain, featureKey);

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
