import type Parser from "web-tree-sitter";
import { parseWithTreeSitter } from "../wasm-loader.ts";
import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { isIgnoredDirectory } from "../../resources/ignore.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

const HONO_VERBS = new Set(["get", "post", "put", "patch", "delete", "all"]);

interface ExtractedRoute {
  file: string;
  relPath: string;
  routerVar: string;
  httpMethods: string[];
  rawPath: string;
  middlewares: Array<{ symbol: string; line: number }>;
  validationSchema?: { symbol: string; file?: string; line?: number };
  handler: { symbol: string; line: number; node?: Parser.SyntaxNode };
  routeLine: number;
}

interface ExtractedMount {
  file: string;
  relPath: string;
  callerVar: string;
  prefix: string;
  targetVar: string;
  line: number;
}

function cleanLiteral(node: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "string") {
    const raw = node.text.trim();
    return raw.replace(/^['"`]|['"`]$/g, "");
  }
  return undefined;
}

function normalizeRouteUri(prefix: string, rawPath: string): string {
  const p = (prefix ?? "").trim().replace(/\/+$/, "");
  let r = (rawPath ?? "").trim();
  if (!r.startsWith("/")) r = "/" + r;
  if (r === "/" && p.length > 0) return `${p}/`;
  if (r === "/" && p.length === 0) return "/";
  const joined = `${p}${r}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

export class HonoSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "hono";
  public readonly name = "Hono Router & Middleware Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "hono") return true;

    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readOptionalSourceFile(pkgPath, "utf-8"));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (deps.hono) return true;
      } catch {}
    }

    // Check entrypoint source code
    for (const entry of ["src/index.ts", "src/app.ts", "index.ts", "app.ts", "src/server.ts"]) {
      const full = path.join(projectRoot, entry);
      if (fs.existsSync(full)) {
        try {
          const content = readOptionalSourceFile(full, "utf-8");
          if (content.includes("from \"hono\"") || content.includes("from 'hono'") || content.includes("require(\"hono\")")) {
            return true;
          }
        } catch {}
      }
    }

    return false;
  }

  public async extractSlices(
    projectRoot: string,
    domainId?: number,
    signal?: AbortSignal
  ): Promise<VerticalSliceCandidate[]> {
    const slices: VerticalSliceCandidate[] = [];
    const sourceFiles = this.findSourceFiles(projectRoot);
    const resolver = new ImportResolver(projectRoot);

    const allRoutes: ExtractedRoute[] = [];
    const allMounts: ExtractedMount[] = [];
    const fileImports = new Map<string, Map<string, string>>(); // relPath -> (ident -> targetRelPath)

    for (const file of sourceFiles) {
      if (signal?.aborted) throw new Error("semantic_extraction_cancelled");
      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content.trim()) continue;

      const fileData = await parseWithTreeSitter(
        "typescript",
        content,
        (rootNode) => this.extractFileAst(file, relPath, rootNode, resolver, projectRoot)
      );

      if (fileData) {
        allRoutes.push(...fileData.routes);
        allMounts.push(...fileData.mounts);
        if (fileData.resolvedImports.size > 0) {
          fileImports.set(relPath, fileData.resolvedImports);
        }
      }
    }

    // Resolve Router Prefix Hierarchy
    const routerPrefixes = this.resolvePrefixHierarchy(allMounts, fileImports);

    // Build Vertical Slices (Level 0 – Level 5)
    for (const route of allRoutes) {
      const prefixes = routerPrefixes.get(`${route.relPath}#${route.routerVar}`) || [""];

      for (const prefix of prefixes) {
        for (const httpMethod of route.httpMethods) {
          const fullUri = normalizeRouteUri(prefix, route.rawPath);
          const actionSymbol = route.handler.symbol;
          const rootIdent = actionSymbol.includes(".") ? actionSymbol.split(".")[0] : actionSymbol;
          const imports = fileImports.get(route.relPath);
          const resolvedControllerFile = imports?.get(rootIdent) || route.relPath;
          const fileBase = path.basename(route.relPath).replace(/\.[^.]+$/, "");
          const controllerClass = actionSymbol.includes(".")
            ? actionSymbol.split(".")[0]
            : fileBase.charAt(0).toUpperCase() + fileBase.slice(1);
          const actionName = actionSymbol.includes(".") ? actionSymbol.split(".").pop()! : actionSymbol;

          const chain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
            {
              stage: "ingress",
              symbol: `${httpMethod} ${fullUri}`,
              file: route.relPath,
              line: route.routeLine,
              description: `Hono Route: ${httpMethod} ${fullUri}`,
            },
          ];

          // L2: Validation schema
          if (route.validationSchema) {
            chain.push({
              stage: "validation",
              symbol: route.validationSchema.symbol,
              file: route.validationSchema.file || route.relPath,
              line: route.validationSchema.line,
              description: `Hono Validator: ${route.validationSchema.symbol}`,
            });
          }

          // Middlewares
          for (const mw of route.middlewares) {
            chain.push({
              stage: "middleware",
              symbol: mw.symbol,
              file: route.relPath,
              line: mw.line,
              description: `Hono Middleware: ${mw.symbol}`,
            });
          }

          // L3: Controller Action
          chain.push({
            stage: "controller",
            symbol: actionSymbol,
            file: resolvedControllerFile,
            line: route.handler.line,
            description: `Hono Action Handler`,
          });

          // L4–L5: Tracing Service & Persistence from handler or imported controller
          const scanFile = resolvedControllerFile !== route.relPath ? resolvedControllerFile : route.relPath;
          const fullScanPath = path.resolve(projectRoot, scanFile);
          const scanContent = readOptionalSourceFile(fullScanPath, "utf-8");

          if (scanContent) {
            // Check service calls: orderService.create(...) or OrderService.process(...)
            const sMatch = scanContent.match(/\b([a-zA-Z0-9_]+(?:Service|Usecase))\s*\.\s*([A-Za-z0-9_]+)\s*\(/i);
            let serviceFile: string | undefined;
            if (sMatch) {
              const svcIdent = sMatch[1];
              const svcMethod = sMatch[2];
              const imports = fileImports.get(scanFile);
              let svcImport = imports?.get(svcIdent);
              if (!svcImport && imports) {
                const pascal = svcIdent.charAt(0).toUpperCase() + svcIdent.slice(1);
                svcImport = imports.get(pascal);
                if (!svcImport) {
                  const instMatch = scanContent.match(new RegExp(`\\b(?:const|let|var)\\s+${svcIdent}\\s*=\\s*new\\s+([a-zA-Z0-9_]+)`));
                  if (instMatch) {
                    svcImport = imports.get(instMatch[1]);
                  }
                }
              }
              serviceFile = svcImport;

              chain.push({
                stage: "service",
                symbol: `${svcIdent}::${svcMethod}`,
                ...(serviceFile ? { file: serviceFile } : {}),
                description: `Hono Service Call: ${svcIdent}::${svcMethod}`,
              });
            }

            // Check Prisma / Drizzle / TypeORM persistence in scanFile or serviceFile
            const filesToInspect = [fullScanPath];
            if (serviceFile) filesToInspect.push(path.resolve(projectRoot, serviceFile));

            for (const inspectPath of filesToInspect) {
              const contentToInspect = readOptionalSourceFile(inspectPath, "utf-8");
              if (!contentToInspect) continue;

              const prismaMatch = contentToInspect.match(/prisma\.([a-zA-Z0-9_]+)\.(?:find|create|update|delete|upsert)/);
              const drizzleMatch = contentToInspect.match(/db\.(?:insert|select|update|delete)\s*\(\s*([a-zA-Z0-9_]+)\s*\)/);

              const entityName =
                prismaMatch ? (prismaMatch[1].charAt(0).toUpperCase() + prismaMatch[1].slice(1)) :
                drizzleMatch ? (drizzleMatch[1].charAt(0).toUpperCase() + drizzleMatch[1].slice(1)) : undefined;

              if (entityName && !chain.some((n) => n.stage === "entity")) {
                const inspectRel = path.relative(projectRoot, inspectPath).replace(/\\/g, "/");
                const entImport = fileImports.get(inspectRel)?.get(entityName);

                chain.push({
                  stage: "repository",
                  symbol: `${entityName}Repository`,
                  file: inspectRel,
                  description: prismaMatch ? "Prisma ORM Client" : "Drizzle ORM Query",
                });

                chain.push({
                  stage: "entity",
                  symbol: entityName,
                  ...(entImport ? { file: entImport } : { file: inspectRel }),
                  description: "Database Entity / Schema Model",
                });
              }
            }
          }

          slices.push({
            domain_id: domainId ?? null,
            feature_key: `hono.${controllerClass.toLowerCase()}.${actionName}`,
            http_method: httpMethod,
            route_uri: fullUri,
            route_name: `${controllerClass}.${actionName}`,
            controller_class: controllerClass,
            action_name: actionName,
            controller_file: resolvedControllerFile,
            controller_line: route.handler.line,
            architecture_style: "mvc",
            entry_kind: "http_route",
            execution_chain_json: JSON.stringify(chain),
          });
        }
      }
    }

    return slices;
  }

  private extractFileAst(
    file: string,
    relPath: string,
    rootNode: Parser.SyntaxNode,
    resolver: ImportResolver,
    projectRoot: string
  ): {
    routes: ExtractedRoute[];
    mounts: ExtractedMount[];
    resolvedImports: Map<string, string>;
  } {
    const routes: ExtractedRoute[] = [];
    const mounts: ExtractedMount[] = [];
    const resolvedImports = new Map<string, string>();

    // 1. Collect import statements
    for (const child of rootNode.namedChildren) {
      if (child.type === "import_statement") {
        const sourceNode = child.childForFieldName("source");
        const specifier = cleanLiteral(sourceNode);
        if (!specifier) continue;

        const res = resolver.resolve(specifier, relPath);
        const targetFile = res.status === "resolved" && res.targets[0]?.files[0] ? res.targets[0].files[0] : undefined;
        if (!targetFile) continue;

        const importClause = child.namedChildren.find((c) => c.type === "import_clause");
        if (importClause) {
          for (const ic of importClause.namedChildren) {
            if (ic.type === "identifier") {
              resolvedImports.set(ic.text.trim(), targetFile);
            } else if (ic.type === "namespace_import") {
              const identNode = ic.namedChildren.find((n) => n.type === "identifier");
              if (identNode) resolvedImports.set(identNode.text.trim(), targetFile);
            } else if (ic.type === "named_imports") {
              for (const spec of ic.namedChildren) {
                if (spec.type === "import_specifier") {
                  const alias = spec.childForFieldName("alias");
                  const name = spec.childForFieldName("name") ?? spec.namedChildren[0];
                  const ident = alias ? alias.text.trim() : name ? name.text.trim() : "";
                  if (ident) resolvedImports.set(ident, targetFile);
                }
              }
            }
          }
        }
      }
    }

    // 2. Walk call expressions for routes and sub-route mounts
    const walkCalls = (node: Parser.SyntaxNode): void => {
      if (node.type === "call_expression") {
        const fnNode = node.childForFieldName("function");
        if (fnNode && fnNode.type === "member_expression") {
          const objNode = fnNode.childForFieldName("object");
          const propNode = fnNode.childForFieldName("property");
          const argsNode = node.childForFieldName("arguments");

          if (objNode && propNode && argsNode) {
            const callerVar = objNode.text.trim();
            const methodName = propNode.text.trim();
            const lowerMethod = methodName.toLowerCase();
            const args = argsNode.namedChildren;

            // Route Mount: app.route('/prefix', subRouter)
            if (lowerMethod === "route") {
              if (args.length >= 2) {
                const prefixLit = cleanLiteral(args[0]);
                const targetArg = args[1];
                if (prefixLit !== undefined && targetArg.type === "identifier") {
                  mounts.push({
                    file,
                    relPath,
                    callerVar,
                    prefix: prefixLit,
                    targetVar: targetArg.text.trim(),
                    line: node.startPosition.row + 1,
                  });
                }
              }
            } else if (HONO_VERBS.has(lowerMethod)) {
              // Direct route: app.get('/path', ...middlewares, handler)
              if (args.length >= 2) {
                const rawPath = cleanLiteral(args[0]);
                if (rawPath !== undefined) {
                  const middleNodes = args.slice(1, args.length - 1);
                  const handlerNode = args[args.length - 1];

                  const { middlewares, validationSchema } = this.extractMiddlewaresAndValidation(
                    middleNodes,
                    resolvedImports,
                    projectRoot
                  );
                  const handler = this.extractSingleHandler(handlerNode);

                  routes.push({
                    file,
                    relPath,
                    routerVar: callerVar,
                    httpMethods: lowerMethod === "all" ? ["GET", "POST", "PUT", "DELETE"] : [lowerMethod.toUpperCase()],
                    rawPath,
                    middlewares,
                    validationSchema,
                    handler,
                    routeLine: node.startPosition.row + 1,
                  });
                }
              }
            } else if (lowerMethod === "on") {
              // Multi-method route: app.on(['GET', 'POST'], '/path', handler)
              if (args.length >= 3) {
                const methodsNode = args[0];
                const rawPath = cleanLiteral(args[1]);
                if (rawPath !== undefined) {
                  const httpMethods: string[] = [];
                  if (methodsNode.type === "array") {
                    for (const el of methodsNode.namedChildren) {
                      const lit = cleanLiteral(el);
                      if (lit) httpMethods.push(lit.toUpperCase());
                    }
                  } else {
                    const lit = cleanLiteral(methodsNode);
                    if (lit) httpMethods.push(lit.toUpperCase());
                  }

                  const middleNodes = args.slice(2, args.length - 1);
                  const handlerNode = args[args.length - 1];
                  const { middlewares, validationSchema } = this.extractMiddlewaresAndValidation(
                    middleNodes,
                    resolvedImports,
                    projectRoot
                  );
                  const handler = this.extractSingleHandler(handlerNode);

                  routes.push({
                    file,
                    relPath,
                    routerVar: callerVar,
                    httpMethods: httpMethods.length > 0 ? httpMethods : ["GET"],
                    rawPath,
                    middlewares,
                    validationSchema,
                    handler,
                    routeLine: node.startPosition.row + 1,
                  });
                }
              }
            }
          }
        }
      }

      for (const child of node.namedChildren) {
        walkCalls(child);
      }
    };

    walkCalls(rootNode);
    return { routes, mounts, resolvedImports };
  }

  private extractMiddlewaresAndValidation(
    nodes: Parser.SyntaxNode[],
    resolvedImports: Map<string, string>,
    projectRoot: string
  ): {
    middlewares: Array<{ symbol: string; line: number }>;
    validationSchema?: { symbol: string; file?: string; line?: number };
  } {
    const middlewares: Array<{ symbol: string; line: number }> = [];
    let validationSchema: { symbol: string; file?: string; line?: number } | undefined;

    for (const node of nodes) {
      if (node.type === "call_expression") {
        const fnNode = node.childForFieldName("function");
        const fnName = fnNode ? fnNode.text.trim() : "";

        // Detect validator middleware: zValidator('json', createOrderSchema)
        if (fnName === "zValidator" || fnName === "validator" || fnName === "vValidator") {
          const args = node.childForFieldName("arguments")?.namedChildren ?? [];
          if (args.length >= 2) {
            const schemaArg = args[1];
            const schemaSymbol = schemaArg.text.trim();
            const schemaFile = resolvedImports.get(schemaSymbol);
            validationSchema = {
              symbol: schemaSymbol,
              file: schemaFile,
              line: node.startPosition.row + 1,
            };
            continue;
          }
        }
      }

      const line = node.startPosition.row + 1;
      if (node.type === "identifier" || node.type === "member_expression") {
        middlewares.push({ symbol: node.text.trim(), line });
      }
    }

    return { middlewares, validationSchema };
  }

  private extractSingleHandler(node: Parser.SyntaxNode): { symbol: string; line: number; node: Parser.SyntaxNode } {
    const line = node.startPosition.row + 1;
    if (node.type === "identifier" || node.type === "member_expression") {
      return { symbol: node.text.trim(), line, node };
    }
    if (node.type === "arrow_function" || node.type === "function_expression" || node.type === "function") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text.trim() : "closure";
      return { symbol: name, line, node };
    }
    return { symbol: "closure", line, node };
  }

  private resolvePrefixHierarchy(
    allMounts: ExtractedMount[],
    fileImports: Map<string, Map<string, string>>
  ): Map<string, string[]> {
    const parentMap = new Map<string, Array<{ parentKey: string; prefix: string }>>();
    const allRouterKeys = new Set<string>();

    for (const m of allMounts) {
      const parentKey = `${m.relPath}#${m.callerVar}`;
      allRouterKeys.add(parentKey);

      let targetKey: string | undefined;
      const importedFile = fileImports.get(m.relPath)?.get(m.targetVar);
      if (importedFile) {
        targetKey = `${importedFile}#${m.targetVar}`;
      } else {
        targetKey = `${m.relPath}#${m.targetVar}`;
      }

      allRouterKeys.add(targetKey);
      if (!parentMap.has(targetKey)) parentMap.set(targetKey, []);
      parentMap.get(targetKey)!.push({ parentKey, prefix: m.prefix });
    }

    const prefixesByRouter = new Map<string, string[]>();

    for (const rKey of allRouterKeys) {
      const parents = parentMap.get(rKey);
      if (!parents || parents.length === 0) {
        prefixesByRouter.set(rKey, [""]);
      }
    }

    const queue = Array.from(prefixesByRouter.keys());
    const visitedEdges = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentPrefixes = prefixesByRouter.get(current) ?? [""];

      for (const [targetKey, parents] of parentMap.entries()) {
        for (const p of parents) {
          if (p.parentKey === current) {
            const edgeKey = `${current}->${targetKey}:${p.prefix}`;
            if (visitedEdges.has(edgeKey)) continue;
            visitedEdges.add(edgeKey);

            const nextPrefixes = currentPrefixes.map((cp) => normalizeRouteUri(cp, p.prefix));
            const existing = prefixesByRouter.get(targetKey) ?? [];
            const merged = Array.from(new Set([...existing, ...nextPrefixes]));
            prefixesByRouter.set(targetKey, merged);
            queue.push(targetKey);
          }
        }
      }
    }

    return prefixesByRouter;
  }

  private findSourceFiles(dir: string): string[] {
    const results: string[] = [];
    const traverse = (current: string) => {
      if (!fs.existsSync(current)) return;
      try {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          if (isIgnoredDirectory(entry.name)) continue;
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            traverse(full);
          } else if (entry.isFile() && /\.(ts|js|tsx|jsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
            results.push(full);
          }
        }
      } catch {}
    };
    traverse(dir);
    return results;
  }
}

