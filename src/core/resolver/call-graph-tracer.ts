import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import type {
  ExecutionChainNode,
  FileRecord,
  SymbolRecord,
  VerticalSliceRecord,
} from "../../types/index.ts";
import type { SeptumRepository } from "../database/repository.ts";

export interface DiscoveredRoute {
  method: string;
  uri: string;
  file: string;
  line: number;
  middlewareSymbols: string[];
  handlerSymbol?: string;
  handlerClass?: string;
  handlerMethod?: string;
}

export class CallGraphTracer {
  private fileMapByNormPath: Map<string, FileRecord> = new Map();
  private symbolsByFileId: Map<number, SymbolRecord[]> = new Map();
  private dependenciesByFileId: Map<
    number,
    Array<{ target: string; statement: string; line_number: number; is_external: boolean }>
  > = new Map();

  constructor(private repo: SeptumRepository, private projectRoot: string = process.cwd()) {}

  /**
   * Initializes internal fast lookup maps from SQLite repository data.
   */
  public initMaps(): void {
    const allSymbolsWithFiles = this.repo.getAllSymbolsWithFiles();
    const allDeps = this.repo.getAllDependenciesWithDomains();

    // Map files
    const allDomains = this.repo.getAllDomains();
    for (const domain of allDomains) {
      const files = this.repo.getFilesByDomain(domain.id);
      for (const f of files) {
        const norm = this.normalizeFilePath(f.path);
        this.fileMapByNormPath.set(norm, f);
      }
    }

    // Map symbols
    for (const s of allSymbolsWithFiles) {
      const existing = this.symbolsByFileId.get(s.file_id) || [];
      existing.push(s);
      this.symbolsByFileId.set(s.file_id, existing);
    }

    // Map dependencies
    for (const d of allDeps) {
      const file = this.fileMapByNormPath.get(this.normalizeFilePath(d.source_file));
      if (file) {
        const existing = this.dependenciesByFileId.get(file.id) || [];
        existing.push({
          target: d.target,
          statement: d.statement,
          line_number: d.line_number,
          is_external: d.is_external,
        });
        this.dependenciesByFileId.set(file.id, existing);
      }
    }
  }

  /**
   * Discover declarative HTTP routes from known route/router files in the repository.
   */
  public discoverDeclarativeRoutes(): DiscoveredRoute[] {
    const discovered: DiscoveredRoute[] = [];

    for (const [normPath, file] of this.fileMapByNormPath.entries()) {
      const isRouteFile =
        file.archetype === "route" ||
        /routes?|router|endpoints?/i.test(normPath) ||
        /\.(routes?|router)\.[tj]sx?$/i.test(normPath);

      if (!isRouteFile) continue;

      const fullPath = resolve(this.projectRoot, file.path);
      if (!existsSync(fullPath)) continue;

      try {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Pattern: router.post('/api/orders', validateMiddleware, controller.action)
          // or app.get('/orders', handler)
          const match = line.match(
            /(?:router|app|server|api)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(.+)\)/i
          );

          if (match) {
            const method = match[1].toUpperCase();
            const uri = match[2];
            const rawArgs = match[3];

            const argTokens = rawArgs
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t.length > 0 && !t.startsWith("//"));

            const middlewareSymbols: string[] = [];
            let handlerSymbol: string | undefined;
            let handlerClass: string | undefined;
            let handlerMethod: string | undefined;

            if (argTokens.length === 1) {
              handlerSymbol = argTokens[0];
            } else if (argTokens.length > 1) {
              handlerSymbol = argTokens[argTokens.length - 1];
              middlewareSymbols.push(...argTokens.slice(0, argTokens.length - 1));
            }

            if (handlerSymbol) {
              // Extract Class.method or classInstance.method
              const parts = handlerSymbol.split(".");
              if (parts.length === 2) {
                handlerClass = parts[0];
                handlerMethod = parts[1];
              } else if (handlerSymbol.includes("::")) {
                const colParts = handlerSymbol.split("::");
                handlerClass = colParts[0];
                handlerMethod = colParts[1];
              }
            }

            discovered.push({
              method,
              uri,
              file: file.path,
              line: i + 1,
              middlewareSymbols,
              handlerSymbol,
              handlerClass,
              handlerMethod,
            });
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Septum CallGraph Warning] Route discovery failed for ${file.path}: ${msg}`);
      }
    }

    return discovered;
  }

  /**
   * Build execution chains for all discovered entrypoints and controller actions.
   */
  public traceAllSlices(): Array<Omit<VerticalSliceRecord, "id" | "created_at">> {
    this.initMaps();
    const slices: Array<Omit<VerticalSliceRecord, "id" | "created_at">> = [];
    const declarativeRoutes = this.discoverDeclarativeRoutes();

    // 1. Trace from declarative routes
    for (const route of declarativeRoutes) {
      const chain = this.traceChainFromRoute(route);
      if (chain.length > 0) {
        const sliceRecord = this.buildSliceRecordFromChain(
          route.method,
          route.uri,
          chain,
          "clean"
        );
        slices.push(sliceRecord);
      }
    }

    // 2. Trace controllers if routes were not explicitly bound or found
    for (const [normPath, file] of this.fileMapByNormPath.entries()) {
      const isController =
        file.archetype === "controller" ||
        /controller/i.test(normPath) ||
        normPath.endsWith("Controller.ts") ||
        normPath.endsWith("Controller.js");

      if (!isController) continue;

      const symbols = this.symbolsByFileId.get(file.id) || [];
      const methods = symbols.filter((s) => s.kind === "method" || s.kind === "function");

      const ctrlName =
        symbols.find((s) => s.kind === "class")?.name ||
        file.path.split("/").pop()?.replace(/\.[^.]+$/, "") ||
        "Controller";

      for (const m of methods) {
        // Skip constructors or private helpers
        if (m.name === "constructor" || m.name.startsWith("_")) continue;

        // Check if this method was already covered by declarative routes
        const alreadyCovered = slices.some(
          (s) =>
            s.controller_file === file.path &&
            s.action_name.toLowerCase() === m.name.toLowerCase()
        );
        if (alreadyCovered) continue;

        const chain = this.traceChainFromController(file, m);
        if (chain.length > 0) {
          const defaultMethod = /create|store|save|add/i.test(m.name)
            ? "POST"
            : /update|edit|patch/i.test(m.name)
            ? "PUT"
            : /delete|remove|destroy/i.test(m.name)
            ? "DELETE"
            : "GET";

          const inferredUri = this.inferRouteUri(file.path, m.name);
          const sliceRecord = this.buildSliceRecordFromChain(
            defaultMethod,
            inferredUri,
            chain,
            "clean"
          );
          slices.push(sliceRecord);
        }
      }
    }

    return slices;
  }

  /**
   * Trace execution chain starting from a declarative route.
   */
  public traceChainFromRoute(route: DiscoveredRoute): ExecutionChainNode[] {
    const chain: ExecutionChainNode[] = [];

    // Stage 1: Ingress
    chain.push({
      stage: "ingress",
      symbol: `${route.method} ${route.uri}`,
      file: route.file,
      line: route.line,
      description: `HTTP Route Ingress: ${route.method} ${route.uri}`,
    });

    // Stage 2: Validation / Middleware
    for (const mw of route.middlewareSymbols) {
      const mwLoc = this.locateSymbol(mw, route.file);
      chain.push({
        stage: "validation",
        symbol: mw,
        file: mwLoc?.file,
        line: mwLoc?.line,
        description: `Request Validation / Middleware: ${mw}`,
      });
    }

    // Stage 3: Controller / Handler
    let controllerFile: FileRecord | undefined;
    let actionMethod = route.handlerMethod || route.handlerSymbol || "handle";

    if (route.handlerClass) {
      const found = this.findFileBySymbolOrName(route.handlerClass, route.file);
      if (found) {
        controllerFile = found.file;
        if (!route.handlerMethod && found.symbol) {
          actionMethod = found.symbol.name;
        }
      }
    } else if (route.handlerSymbol) {
      const found = this.findFileBySymbolOrName(route.handlerSymbol, route.file);
      if (found) {
        controllerFile = found.file;
      }
    }

    if (controllerFile) {
      const syms = this.symbolsByFileId.get(controllerFile.id) || [];
      const methodSym = syms.find(
        (s) => s.name.toLowerCase() === actionMethod.toLowerCase()
      );

      const ctrlName =
        syms.find((s) => s.kind === "class")?.name ||
        controllerFile.path.split("/").pop()?.replace(/\.[^.]+$/, "") ||
        "Controller";

      chain.push({
        stage: "controller",
        symbol: `${ctrlName}::${actionMethod}`,
        file: controllerFile.path,
        line: methodSym?.line_start || 1,
        description: `Controller Action: ${ctrlName}::${actionMethod}`,
      });

      // Forward reachability BFS from controller
      this.traverseOutboundDependencies(controllerFile, chain);
    }

    return chain;
  }

  /**
   * Trace execution chain starting from a controller method.
   */
  public traceChainFromController(
    controllerFile: FileRecord,
    method: SymbolRecord
  ): ExecutionChainNode[] {
    const chain: ExecutionChainNode[] = [];
    const syms = this.symbolsByFileId.get(controllerFile.id) || [];
    const ctrlName =
      syms.find((s) => s.kind === "class")?.name ||
      controllerFile.path.split("/").pop()?.replace(/\.[^.]+$/, "") ||
      "Controller";

    // Stage 1: Ingress (inferred)
    const inferredUri = this.inferRouteUri(controllerFile.path, method.name);
    const defaultMethod = /create|store|save|add/i.test(method.name)
      ? "POST"
      : /update|edit|patch/i.test(method.name)
      ? "PUT"
      : /delete|remove|destroy/i.test(method.name)
      ? "DELETE"
      : "GET";

    chain.push({
      stage: "ingress",
      symbol: `${defaultMethod} ${inferredUri}`,
      file: controllerFile.path,
      line: method.line_start,
      description: `Inferred Ingress: ${defaultMethod} ${inferredUri}`,
    });

    // Stage 3: Controller
    chain.push({
      stage: "controller",
      symbol: `${ctrlName}::${method.name}`,
      file: controllerFile.path,
      line: method.line_start,
      description: `Controller Action: ${ctrlName}::${method.name}`,
    });

    // Forward reachability BFS
    this.traverseOutboundDependencies(controllerFile, chain);

    return chain;
  }

  /**
   * Traverse outbound dependencies using BFS with cycle detection and max hop limit.
   */
  private traverseOutboundDependencies(
    startFile: FileRecord,
    chain: ExecutionChainNode[],
    maxDepth: number = 6
  ): void {
    const visitedFiles = new Set<string>();
    visitedFiles.add(startFile.path);

    const queue: Array<{ file: FileRecord; depth: number }> = [
      { file: startFile, depth: 1 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth > maxDepth) break;

      const deps = this.dependenciesByFileId.get(current.file.id) || [];

      for (const dep of deps) {
        if (dep.is_external) continue;

        const resolvedFile = this.resolveImportToFile(current.file.path, dep.target);
        if (!resolvedFile || visitedFiles.has(resolvedFile.path)) continue;

        visitedFiles.add(resolvedFile.path);

        const stage = this.detectStage(resolvedFile.path, resolvedFile.archetype);
        const fileSymbols = this.symbolsByFileId.get(resolvedFile.id) || [];
        const mainSymbol =
          fileSymbols.find((s) => s.kind === "class" || s.kind === "interface") ||
          fileSymbols.find((s) => s.kind === "function") ||
          fileSymbols[0];

        const symbolDisplay = mainSymbol
          ? `${mainSymbol.name}${mainSymbol.kind === "class" ? "::execute" : ""}`
          : resolvedFile.path.split("/").pop()?.replace(/\.[^.]+$/, "") || "Module";

        // Prevent adding duplicate stages if already present, or add as refinement
        const existingStageNode = chain.find(
          (c) => c.stage === stage && c.file === resolvedFile.path
        );

        if (!existingStageNode) {
          chain.push({
            stage,
            symbol: symbolDisplay,
            file: resolvedFile.path,
            line: mainSymbol?.line_start || 1,
            description: `${stage.toUpperCase()}: ${symbolDisplay}`,
          });
        }

        queue.push({ file: resolvedFile, depth: current.depth + 1 });
      }
    }

    // Sort stages according to standard pipeline order
    const stageOrder: Record<string, number> = {
      ingress: 1,
      validation: 2,
      controller: 3,
      orchestrator: 3,
      use_case: 4,
      service: 4,
      domain: 5,
      entity: 5,
      egress: 6,
      repository: 6,
    };

    chain.sort((a, b) => {
      const orderA = stageOrder[a.stage] || 99;
      const orderB = stageOrder[b.stage] || 99;
      return orderA - orderB;
    });
  }

  /**
   * Detect generic pipeline stage from file path and archetype.
   */
  public detectStage(filePath: string, archetype: string): string {
    const norm = filePath.toLowerCase();

    if (
      archetype === "validation" ||
      archetype === "dto" ||
      /validation|middleware|dto|request|schema/i.test(norm)
    ) {
      return "validation";
    }

    if (archetype === "controller" || /controller|handler/i.test(norm)) {
      return "controller";
    }

    if (
      archetype === "service" ||
      archetype === "use_case" ||
      /use-?cases?|interactor|application|workflow/i.test(norm)
    ) {
      return "use_case";
    }

    if (
      archetype === "model" ||
      archetype === "entity" ||
      /domain|entities|entity|aggregate/i.test(norm)
    ) {
      return "entity";
    }

    if (
      archetype === "repository" ||
      /repositories|repository|database|persistence|egress|adapter/i.test(norm)
    ) {
      return "repository";
    }

    return "service";
  }

  /**
   * Resolve an import target path (relative or alias) to a FileRecord in the catalog.
   */
  public resolveImportToFile(sourceFilePath: string, importTarget: string): FileRecord | undefined {
    // 1. Relative import (./ or ../)
    if (importTarget.startsWith(".")) {
      const sourceDir = dirname(sourceFilePath);
      const combined = normalize(join(sourceDir, importTarget)).replace(/\\/g, "/");

      const candidates = [
        combined,
        `${combined}.ts`,
        `${combined}.tsx`,
        `${combined}.js`,
        `${combined}.jsx`,
        `${combined}/index.ts`,
        `${combined}/index.js`,
      ];

      for (const cand of candidates) {
        const found = this.fileMapByNormPath.get(this.normalizeFilePath(cand));
        if (found) return found;
      }
    }

    // 2. Alias import (@/... or src/...)
    const cleanAlias = importTarget.replace(/^@\//, "src/");
    const aliasCandidates = [
      cleanAlias,
      `${cleanAlias}.ts`,
      `${cleanAlias}.tsx`,
      `${cleanAlias}.js`,
      `${cleanAlias}.jsx`,
      `${cleanAlias}/index.ts`,
      `${cleanAlias}/index.js`,
    ];

    for (const cand of aliasCandidates) {
      const found = this.fileMapByNormPath.get(this.normalizeFilePath(cand));
      if (found) return found;
    }

    // 3. Basename search fallback
    const baseTarget = importTarget.split("/").pop()?.replace(/\.[^.]+$/, "");
    if (baseTarget && baseTarget.length > 3) {
      for (const [norm, file] of this.fileMapByNormPath.entries()) {
        if (norm.includes(`/${baseTarget.toLowerCase()}.`) || norm.endsWith(`/${baseTarget.toLowerCase()}`)) {
          return file;
        }
      }
    }

    return undefined;
  }

  /**
   * Locate a symbol in the codebase or relative to a file.
   */
  private locateSymbol(
    symbolName: string,
    relativeToFile?: string
  ): { file: string; line: number } | null {
    const cleanSymbol = symbolName.replace(/[()]/g, "").trim();

    // Check imports of relativeToFile first
    if (relativeToFile) {
      const file = this.fileMapByNormPath.get(this.normalizeFilePath(relativeToFile));
      if (file) {
        const deps = this.dependenciesByFileId.get(file.id) || [];
        for (const dep of deps) {
          if (dep.target.includes(cleanSymbol) || dep.statement.includes(cleanSymbol)) {
            const targetFile = this.resolveImportToFile(relativeToFile, dep.target);
            if (targetFile) {
              const syms = this.symbolsByFileId.get(targetFile.id) || [];
              const s = syms.find((sym) => sym.name === cleanSymbol);
              return {
                file: targetFile.path,
                line: s?.line_start || 1,
              };
            }
          }
        }
      }
    }

    // Global symbol search
    for (const [fileId, syms] of this.symbolsByFileId.entries()) {
      const match = syms.find((s) => s.name === cleanSymbol);
      if (match) {
        for (const file of this.fileMapByNormPath.values()) {
          if (file.id === fileId) {
            return { file: file.path, line: match.line_start };
          }
        }
      }
    }

    return null;
  }

  /**
   * Find FileRecord and Symbol by identifier or class name.
   */
  private findFileBySymbolOrName(
    ident: string,
    contextFile?: string
  ): { file: FileRecord; symbol?: SymbolRecord } | null {
    const cleanIdent = ident.replace(/controller$/i, "").toLowerCase();

    // 1. Try imports of contextFile
    if (contextFile) {
      const srcFile = this.fileMapByNormPath.get(this.normalizeFilePath(contextFile));
      if (srcFile) {
        const deps = this.dependenciesByFileId.get(srcFile.id) || [];
        for (const d of deps) {
          if (d.statement.toLowerCase().includes(cleanIdent) || d.target.toLowerCase().includes(cleanIdent)) {
            const resolved = this.resolveImportToFile(contextFile, d.target);
            if (resolved) {
              const syms = this.symbolsByFileId.get(resolved.id) || [];
              const sym = syms.find(
                (s) => s.name.toLowerCase() === ident.toLowerCase() || s.name.toLowerCase().includes(cleanIdent)
              );
              return { file: resolved, symbol: sym };
            }
          }
        }
      }
    }

    // 2. Try match file path
    for (const [norm, file] of this.fileMapByNormPath.entries()) {
      if (norm.toLowerCase().includes(cleanIdent) && norm.toLowerCase().includes("controller")) {
        const syms = this.symbolsByFileId.get(file.id) || [];
        return { file, symbol: syms.find((s) => s.kind === "class") };
      }
    }

    return null;
  }

  /**
   * Build a VerticalSliceRecord structure from an execution chain.
   */
  private buildSliceRecordFromChain(
    httpMethod: string,
    routeUri: string,
    chain: ExecutionChainNode[],
    architectureStyle: string = "clean"
  ): Omit<VerticalSliceRecord, "id" | "created_at"> {
    const controllerNode = chain.find((c) => c.stage === "controller" || c.stage === "orchestrator");

    const ctrlParts = controllerNode?.symbol.split("::") || [];
    const controllerClass = ctrlParts[0] || "Controller";
    const actionName = ctrlParts[1] || "handle";

    return {
      domain_id: null,
      feature_key: null,
      http_method: httpMethod,
      route_uri: routeUri,
      route_name: `${httpMethod.toLowerCase()}.${routeUri.replace(/[^a-zA-Z0-9]/g, "_").replace(/^_+|_+$/g, "")}`,
      controller_class: controllerClass,
      action_name: actionName,
      controller_file: controllerNode?.file || null,
      controller_line: controllerNode?.line || 0,
      architecture_style: architectureStyle,
      entry_kind: "http_route",
      execution_chain_json: JSON.stringify(chain),
    };
  }

  private inferRouteUri(filePath: string, methodName: string): string {
    const base = filePath
      .split("/")
      .pop()
      ?.replace(/controller\.[^.]+$/i, "")
      .replace(/\.[^.]+$/, "")
      .toLowerCase();

    const resource = base ? `/${base}s` : "/resource";
    if (/store|create/i.test(methodName)) return resource;
    if (/show|get|find/i.test(methodName)) return `${resource}/:id`;
    if (/update|edit|patch/i.test(methodName)) return `${resource}/:id`;
    if (/delete|destroy|remove/i.test(methodName)) return `${resource}/:id`;

    return `${resource}/${methodName}`;
  }

  private normalizeFilePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\/?/, "").toLowerCase();
  }
}
