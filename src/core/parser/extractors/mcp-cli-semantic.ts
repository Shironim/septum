import * as fs from "node:fs";
import * as path from "node:path";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

export class McpCliSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "mcp-cli";
  public readonly name = "MCP Server & CLI Semantic Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "mcp-server" || framework === "cli") return true;

    // Check presence of CLI or MCP directories
    const hasMcp = fs.existsSync(path.join(projectRoot, "src/mcp/tools"));
    const hasCli = fs.existsSync(path.join(projectRoot, "src/cli/commands"));
    if (hasMcp || hasCli) return true;

    // Check package.json for bin or MCP SDK
    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.bin || pkg.dependencies?.["@modelcontextprotocol/sdk"]) {
          return true;
        }
      } catch {}
    }

    return false;
  }

  public extractSlices(projectRoot: string, domainId?: number): VerticalSliceCandidate[] {
    const slices: VerticalSliceCandidate[] = [];

    // 1. Extract MCP Tools
    const mcpToolsDir = path.join(projectRoot, "src/mcp/tools");
    if (fs.existsSync(mcpToolsDir)) {
      try {
        const toolFiles = fs
          .readdirSync(mcpToolsDir)
          .filter((f) => f.endsWith(".ts") || f.endsWith(".js"));

        for (const file of toolFiles) {
          const fullPath = path.join(mcpToolsDir, file);
          const relPath = path.relative(projectRoot, fullPath);
          const content = fs.readFileSync(fullPath, "utf-8");
          const baseName = path.basename(file, path.extname(file)); // e.g. 'get-domain-catalog'
          const toolIdentifier = `septum_${baseName.replace(/-/g, "_")}`;

          // Detect handler function
          const handlerMatch = content.match(/export\s+async?\s+function\s+([a-zA-Z0-9_]+)/);
          const actionName = handlerMatch ? handlerMatch[1] : `handle_${baseName}`;

          // Detect args interface
          const argsMatch = content.match(/export\s+interface\s+([a-zA-Z0-9_]+Args)/);
          const formRequestClass = argsMatch ? argsMatch[1] : null;

          // Detect model/service dependency (e.g. SeptumRepository, ConfigLoader)
          let modelClass: string | null = null;
          if (content.includes("SeptumRepository")) modelClass = "SeptumRepository";
          else if (content.includes("SessionManager")) modelClass = "SessionManager";
          else if (content.includes("ConfigLoader")) modelClass = "ConfigLoader";

          const mcpChain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
            {
              stage: "ingress",
              symbol: `tool:${toolIdentifier}`,
              file: relPath,
              description: `MCP Tool Endpoint: ${toolIdentifier}`,
            },
          ];

          if (formRequestClass) {
            mcpChain.push({
              stage: "validation",
              symbol: formRequestClass,
              file: relPath,
              description: "MCP Argument Schema",
            });
          }

          mcpChain.push({
            stage: "controller",
            symbol: `McpToolHandler::${actionName}`,
            file: relPath,
            line: 1,
            description: `Tool Handler Execution`,
          });

          if (modelClass) {
            mcpChain.push({
              stage: "service",
              symbol: modelClass,
              file: "src/core/database/repository.ts",
              description: "Core Engine Service",
            });
          }

          slices.push({
            domain_id: domainId ?? null,
            feature_key: `mcp.${baseName}`,
            http_method: "MCP",
            route_uri: `tool:${toolIdentifier}`,
            route_name: toolIdentifier,
            controller_class: "McpToolHandler",
            action_name: actionName,
            controller_file: relPath,
            controller_line: 1,
            architecture_style: "rpc",
            entry_kind: "mcp_tool",
            execution_chain_json: JSON.stringify(mcpChain),
          });
        }
      } catch {}
    }

    // 2. Extract CLI Commands
    const cliCommandsDir = path.join(projectRoot, "src/cli/commands");
    if (fs.existsSync(cliCommandsDir)) {
      try {
        const commandFiles = fs
          .readdirSync(cliCommandsDir)
          .filter((f) => f.endsWith(".ts") || f.endsWith(".js"));

        for (const file of commandFiles) {
          const fullPath = path.join(cliCommandsDir, file);
          const relPath = path.relative(projectRoot, fullPath);
          const content = fs.readFileSync(fullPath, "utf-8");
          const commandName = path.basename(file, path.extname(file)); // e.g. 'ingest', 'check'

          const handlerMatch = content.match(/export\s+async?\s+function\s+([a-zA-Z0-9_]+Command)/);
          const actionName = handlerMatch ? handlerMatch[1] : `handle${commandName.charAt(0).toUpperCase() + commandName.slice(1)}Command`;

          // Detect options / args
          const optionsMatch = content.match(/interface\s+([a-zA-Z0-9_]+Options)/);
          const formRequestClass = optionsMatch ? optionsMatch[1] : null;

          // Detect Core Service used
          let modelClass: string | null = null;
          if (content.includes("IngestionPipeline")) modelClass = "IngestionPipeline";
          else if (content.includes("BoundaryEvaluator")) modelClass = "BoundaryEvaluator";
          else if (content.includes("VerticalSliceTracer")) modelClass = "VerticalSliceTracer";
          else if (content.includes("SeptumRepository")) modelClass = "SeptumRepository";

          const cliChain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
            {
              stage: "ingress",
              symbol: `septum ${commandName}`,
              file: relPath,
              description: `CLI Command Entrypoint: septum ${commandName}`,
            },
          ];

          if (formRequestClass) {
            cliChain.push({
              stage: "validation",
              symbol: formRequestClass,
              file: relPath,
              description: "CLI Options Interface",
            });
          }

          cliChain.push({
            stage: "controller",
            symbol: `CLICommandHandler::${actionName}`,
            file: relPath,
            line: 1,
            description: "Command Execution Handler",
          });

          if (modelClass) {
            cliChain.push({
              stage: "service",
              symbol: modelClass,
              file: "src/core/",
              description: "Core Engine Service",
            });
          }

          slices.push({
            domain_id: domainId ?? null,
            feature_key: `cli.${commandName}`,
            http_method: "CLI",
            route_uri: `command:${commandName}`,
            route_name: `septum ${commandName}`,
            controller_class: "CLICommandHandler",
            action_name: actionName,
            controller_file: relPath,
            controller_line: 1,
            architecture_style: "cli",
            entry_kind: "cli_command",
            execution_chain_json: JSON.stringify(cliChain),
          });
        }
      } catch {}
    }

    return slices;
  }
}
