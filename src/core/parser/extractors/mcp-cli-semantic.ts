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
    const { toolPrefix, cliBinName } = this.resolveProjectNaming(projectRoot);
    const registeredTools = this.scanRegisteredMcpToolNames(projectRoot);

    // 1. Extract MCP Tools
    const mcpToolsDir = path.join(projectRoot, "src/mcp/tools");
    if (fs.existsSync(mcpToolsDir)) {
      try {
        const toolFiles = fs
          .readdirSync(mcpToolsDir)
          .filter((f) => f.endsWith(".ts") || f.endsWith(".js"));

        for (const file of toolFiles) {
          const fullPath = path.join(mcpToolsDir, file);
          const relPath = path.relative(projectRoot, fullPath).replace(/\\/g, "/");
          const content = fs.readFileSync(fullPath, "utf-8");
          const baseName = path.basename(file, path.extname(file));
          const snakeBase = baseName.replace(/-/g, "_");
          const toolIdentifier =
            registeredTools.get(snakeBase) || `${toolPrefix}_${snakeBase}`;

          // Detect handler function (both sync and async) and its 1-indexed line number
          const handlerMatch = /export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)/.exec(content);
          const classMatch = /export\s+class\s+([A-Za-z0-9_]+)/.exec(content);
          const actionName = handlerMatch ? handlerMatch[1] : `handle_${snakeBase}`;
          const controllerClass = classMatch ? classMatch[1] : baseName;
          const handlerLine =
            handlerMatch && handlerMatch.index !== undefined
              ? content.slice(0, handlerMatch.index).split("\n").length
              : 1;

          // Detect args interface and its line number
          const argsMatch = /(?:export\s+)?interface\s+([a-zA-Z0-9_]+Args)\b/.exec(content);
          const formRequestClass = argsMatch ? argsMatch[1] : null;
          const argsLine =
            argsMatch && argsMatch.index !== undefined
              ? content.slice(0, argsMatch.index).split("\n").length
              : undefined;

          // Detect service/repository dependency and its actual file path
          const serviceDep = this.resolveServiceDependency(projectRoot, fullPath, content);

          const mcpChain: Array<{
            stage: string;
            symbol: string;
            file?: string;
            line?: number;
            description?: string;
          }> = [
            {
              stage: "ingress",
              symbol: `tool:${toolIdentifier}`,
              file: relPath,
              line: handlerLine,
              description: `MCP Tool Endpoint: ${toolIdentifier}`,
            },
          ];

          if (formRequestClass) {
            mcpChain.push({
              stage: "validation",
              symbol: formRequestClass,
              file: relPath,
              ...(argsLine ? { line: argsLine } : {}),
              description: "MCP Argument Schema",
            });
          }

          mcpChain.push({
            stage: "controller",
            symbol: classMatch ? `${controllerClass}::${actionName}` : actionName,
            file: relPath,
            line: handlerLine,
            description: "Tool Handler Execution",
          });

          if (serviceDep) {
            mcpChain.push({
              stage: "service",
              symbol: serviceDep.symbol,
              ...(serviceDep.file ? { file: serviceDep.file } : {}),
              description: "Core Engine Service",
            });
          }

          slices.push({
            domain_id: domainId ?? null,
            feature_key: `mcp.${baseName}`,
            http_method: "MCP",
            route_uri: `tool:${toolIdentifier}`,
            route_name: toolIdentifier,
            controller_class: controllerClass,
            action_name: actionName,
            controller_file: relPath,
            controller_line: handlerLine,
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
          const relPath = path.relative(projectRoot, fullPath).replace(/\\/g, "/");
          const content = fs.readFileSync(fullPath, "utf-8");
          const commandName = path.basename(file, path.extname(file));

          const handlerMatch = /export\s+(?:async\s+)?function\s+([a-zA-Z0-9_]+)/.exec(content);
          const classMatch = /export\s+class\s+([A-Za-z0-9_]+)/.exec(content);
          const actionName = handlerMatch
            ? handlerMatch[1]
            : `handle${commandName.charAt(0).toUpperCase() + commandName.slice(1)}Command`;
          const controllerClass = classMatch ? classMatch[1] : commandName;
          const handlerLine =
            handlerMatch && handlerMatch.index !== undefined
              ? content.slice(0, handlerMatch.index).split("\n").length
              : 1;

          // Detect options / args
          const optionsMatch = /(?:export\s+)?interface\s+([a-zA-Z0-9_]+(?:Options|Args))\b/.exec(content);
          const formRequestClass = optionsMatch ? optionsMatch[1] : null;
          const optionsLine =
            optionsMatch && optionsMatch.index !== undefined
              ? content.slice(0, optionsMatch.index).split("\n").length
              : undefined;

          const serviceDep = this.resolveServiceDependency(projectRoot, fullPath, content);

          const cliChain: Array<{
            stage: string;
            symbol: string;
            file?: string;
            line?: number;
            description?: string;
          }> = [
            {
              stage: "ingress",
              symbol: `${cliBinName} ${commandName}`,
              file: relPath,
              line: handlerLine,
              description: `CLI Command Entrypoint: ${cliBinName} ${commandName}`,
            },
          ];

          if (formRequestClass) {
            cliChain.push({
              stage: "validation",
              symbol: formRequestClass,
              file: relPath,
              ...(optionsLine ? { line: optionsLine } : {}),
              description: "CLI Options Interface",
            });
          }

          cliChain.push({
            stage: "controller",
            symbol: classMatch ? `${controllerClass}::${actionName}` : actionName,
            file: relPath,
            line: handlerLine,
            description: "Command Execution Handler",
          });

          if (serviceDep) {
            cliChain.push({
              stage: "service",
              symbol: serviceDep.symbol,
              ...(serviceDep.file ? { file: serviceDep.file } : {}),
              description: "Core Engine Service",
            });
          }

          slices.push({
            domain_id: domainId ?? null,
            feature_key: `cli.${commandName}`,
            http_method: "CLI",
            route_uri: `command:${commandName}`,
            route_name: `${cliBinName} ${commandName}`,
            controller_class: controllerClass,
            action_name: actionName,
            controller_file: relPath,
            controller_line: handlerLine,
            architecture_style: "cli",
            entry_kind: "cli_command",
            execution_chain_json: JSON.stringify(cliChain),
          });
        }
      } catch {}
    }

    return slices;
  }

  private resolveProjectNaming(projectRoot: string): { toolPrefix: string; cliBinName: string } {
    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const rawName = typeof pkg.name === "string" ? pkg.name.replace(/^@[^/]+\//, "") : "mcp";
        const toolPrefix = rawName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase() || "mcp";
        let cliBinName = rawName;
        if (typeof pkg.bin === "string") {
          cliBinName = rawName;
        } else if (pkg.bin && typeof pkg.bin === "object") {
          const firstBin = Object.keys(pkg.bin)[0];
          if (firstBin) cliBinName = firstBin;
        }
        return { toolPrefix, cliBinName };
      } catch {}
    }
    return { toolPrefix: "mcp", cliBinName: "cli" };
  }

  private scanRegisteredMcpToolNames(projectRoot: string): Map<string, string> {
    const map = new Map<string, string>();
    const serverPath = path.join(projectRoot, "src/mcp/server.ts");
    if (!fs.existsSync(serverPath)) return map;

    try {
      const content = fs.readFileSync(serverPath, "utf-8");
      const nameRegex = /name:\s*['"]([a-zA-Z0-9_-]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = nameRegex.exec(content)) !== null) {
        const fullToolName = match[1];
        const normalized = fullToolName.replace(/-/g, "_");
        map.set(normalized, fullToolName);
        const withoutPrefix = normalized.replace(/^[a-z0-9]+_/, "");
        if (withoutPrefix) {
          map.set(withoutPrefix, fullToolName);
        }
      }
    } catch {}
    return map;
  }

  private resolveServiceDependency(
    projectRoot: string,
    sourceFile: string,
    content: string
  ): { symbol: string; file?: string } | null {
    const importRegex = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
      const clause = match[1];
      const spec = match[2];
      const identifiers = clause
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);

      for (const id of identifiers) {
        if (
          /(?:Repository|Service|Manager|Loader|Pipeline|Evaluator|Tracer|Detector|Engine|Store)$/.test(
            id
          )
        ) {
          const resolvedFile = this.resolveImportFile(projectRoot, sourceFile, spec);
          return {
            symbol: id,
            ...(resolvedFile ? { file: resolvedFile } : {}),
          };
        }
      }
    }

    return null;
  }

  private resolveImportFile(projectRoot: string, sourceFile: string, importSpec: string): string | undefined {
    if (!importSpec.startsWith(".")) return undefined;
    const baseResolved = path.resolve(path.dirname(sourceFile), importSpec);
    const candidates = [
      baseResolved,
      `${baseResolved}.ts`,
      `${baseResolved}.js`,
      baseResolved.replace(/\.js$/, ".ts"),
      path.join(baseResolved, "index.ts"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        return path.relative(projectRoot, c).replace(/\\/g, "/");
      }
    }
    return undefined;
  }
}

