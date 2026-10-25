import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { parseWithTreeSitter } from "../wasm-loader.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import type Parser from "web-tree-sitter";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

const EXPRESS_VERBS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "head",
  "options",
]);

interface RawRoute {
  file: string;
  relPath: string;
  routerVar: string;
  httpMethod: string;
  rawPath: string;
  middlewares: Array<{ symbol: string; line: number }>;
  handler: { symbol: string; line: number };
  routeLine: number;
}

interface RawMount {
  file: string;
  relPath: string;
  callerVar: string;
  prefix: string;
  targetVar: string;
  line: number;
}

interface ImportBinding {
  importedName: string;
  sourceSpecifier: string;
}

function cleanLiteral(node: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "string" || node.type === "template_string") {
    const raw = node.text.trim();
    if (raw.includes("${")) return undefined;
    return raw.replace(/^['"`]|['"`]$/g, "");
  }
  return undefined;
}

function normalizeRouteUri(prefix: string, rawPath: string): string {
  const p = (prefix ?? "").trim().replace(/\/+$/, "");
  let r = (rawPath ?? "").trim();
  if (!r.startsWith("/")) r = "/" + r;
  if (r === "/" && p.length > 0) return p;
  if (r === "/" && p.length === 0) return "/";
  const joined = `${p}${r}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

export class ExpressSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "express";
  public readonly name = "Express Router Composition Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "express") return true;

    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readOptionalSourceFile(pkgPath, "utf-8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps["express"]) return true;
      } catch {}
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

    const allRoutes: RawRoute[] = [];
    const allMounts: RawMount[] = [];
    const fileImports = new Map<string, Map<string, string>>(); // relPath -> (importedIdent -> targetRelPath)

    for (const file of sourceFiles) {
      if (signal?.aborted) throw new Error("semantic_extraction_cancelled");
      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content || (!content.includes(".get") && !content.includes(".post") && !content.includes(".use") && !content.includes(".route") && !content.includes("Router") && !content.includes("express"))) {
        continue;
      }

      const fileData = await parseWithTreeSitter(
        "typescript",
        content,
        (rootNode) => this.extractFileAst(file, relPath, rootNode, resolver)
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

    // Build Vertical Slices
    for (const route of allRoutes) {
      const prefixes = routerPrefixes.get(`${route.relPath}#${route.routerVar}`) || [""];

      for (const prefix of prefixes) {
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
            symbol: `${route.httpMethod} ${fullUri}`,
            file: route.relPath,
            line: route.routeLine,
            description: `Express Route: ${route.httpMethod} ${fullUri}`,
          },
        ];

        for (const mw of route.middlewares) {
          chain.push({
            stage: "middleware",
            symbol: mw.symbol,
            file: route.relPath,
            line: mw.line,
            description: `Express Middleware: ${mw.symbol}`,
          });
        }

        chain.push({
          stage: "controller",
          symbol: actionSymbol,
          file: resolvedControllerFile,
          line: route.handler.line,
          description: `Express Action Handler`,
        });

        slices.push({
          domain_id: domainId ?? null,
          feature_key: `express.${controllerClass.toLowerCase()}.${actionName}`,
          http_method: route.httpMethod,
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

    return slices;
  }

  private extractFileAst(
    _filePath: string,
    relPath: string,
    rootNode: Parser.SyntaxNode,
    resolver: ImportResolver
  ): { routes: RawRoute[]; mounts: RawMount[]; resolvedImports: Map<string, string> } {
    const routes: RawRoute[] = [];
    const mounts: RawMount[] = [];
    const resolvedImports = new Map<string, string>();

    // 1. Collect static imports
    for (const child of rootNode.namedChildren) {
      if (child.type === "import_statement") {
        const sourceNode =
          child.childForFieldName("source") ??
          child.namedChildren.find((c) => c.type === "string");
        const specifier = cleanLiteral(sourceNode);
        if (!specifier) continue;

        const res = resolver.resolve(specifier, relPath);
        const targetFile = res.status === "resolved" && res.targets[0]?.files[0] ? res.targets[0].files[0] : undefined;
        if (!targetFile) continue;

        // Default import
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

    // 2. Walk call expressions for routes and mounts
    const walkCalls = (node: Parser.SyntaxNode): void => {
      if (node.type === "call_expression") {
        const fnNode = node.childForFieldName("function");
        if (fnNode && fnNode.type === "member_expression") {
          const objNode = fnNode.childForFieldName("object");
          const propNode = fnNode.childForFieldName("property");
          const argsNode = node.childForFieldName("arguments");

          if (objNode && propNode && argsNode) {
            const callerVar = objNode.text.trim();
            const methodName = propNode.text.trim().toLowerCase();
            const args = argsNode.namedChildren;

            // Route Mount: app.use('/api', apiRouter) or router.use('/sub', subRouter)
            if (methodName === "use") {
              if (args.length >= 1) {
                const firstLit = cleanLiteral(args[0]);
                const hasPath = firstLit !== undefined;
                const prefix = hasPath ? firstLit : "";
                const targetArg = hasPath ? args[1] : args[0];

                if (targetArg && targetArg.type === "identifier") {
                  mounts.push({
                    file: relPath,
                    relPath,
                    callerVar,
                    prefix,
                    targetVar: targetArg.text.trim(),
                    line: node.startPosition.row + 1,
                  });
                }
              }
            } else if (EXPRESS_VERBS.has(methodName)) {
              // Direct HTTP Route: app.get('/path', ...middlewares, handler)
              if (args.length >= 2) {
                const rawPath = cleanLiteral(args[0]);
                if (rawPath !== undefined) {
                  const middlewareNodes = args.slice(1, args.length - 1);
                  const handlerNode = args[args.length - 1];

                  const middlewares = this.extractHandlers(middlewareNodes);
                  const handler = this.extractSingleHandler(handlerNode);

                  routes.push({
                    file: relPath,
                    relPath,
                    routerVar: callerVar,
                    httpMethod: methodName.toUpperCase(),
                    rawPath,
                    middlewares,
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

  private extractSingleHandler(node: Parser.SyntaxNode): { symbol: string; line: number } {
    const line = node.startPosition.row + 1;
    if (node.type === "identifier" || node.type === "member_expression") {
      return { symbol: node.text.trim(), line };
    }
    if (node.type === "arrow_function" || node.type === "function_expression" || node.type === "function") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text.trim() : "closure";
      return { symbol: name, line };
    }
    return { symbol: "closure", line };
  }

  private extractHandlers(nodes: Parser.SyntaxNode[]): Array<{ symbol: string; line: number }> {
    const list: Array<{ symbol: string; line: number }> = [];
    for (const node of nodes) {
      if (node.type === "array") {
        for (const el of node.namedChildren) {
          list.push(this.extractSingleHandler(el));
        }
      } else {
        list.push(this.extractSingleHandler(node));
      }
    }
    return list;
  }

  private resolvePrefixHierarchy(
    mounts: RawMount[],
    fileImports: Map<string, Map<string, string>>
  ): Map<string, string[]> {
    // Map: (relPath#varName) -> array of prefixes
    const prefixes = new Map<string, Set<string>>();

    const getPrefixes = (key: string): Set<string> => {
      let set = prefixes.get(key);
      if (!set) {
        set = new Set<string>();
        prefixes.set(key, set);
      }
      return set;
    };

    // 1. Identify root app variables (e.g. app in app.ts) which start with root prefix ""
    // Also identify top-level callers that are not targets of any mount
    const targetedCallers = new Set<string>();
    for (const mount of mounts) {
      const fileMap = fileImports.get(mount.relPath);
      const importedFile = fileMap?.get(mount.targetVar);
      if (importedFile) {
        targetedCallers.add(`${importedFile}#router`);
        targetedCallers.add(`${importedFile}#default`);
        targetedCallers.add(`${importedFile}#${mount.targetVar}`);
        for (const m of mounts) {
          if (m.relPath === importedFile) {
            targetedCallers.add(`${importedFile}#${m.callerVar}`);
          }
        }
      } else {
        targetedCallers.add(`${mount.relPath}#${mount.targetVar}`);
      }
    }

    for (const mount of mounts) {
      const callerKey = `${mount.relPath}#${mount.callerVar}`;
      if (mount.callerVar === "app" || mount.callerVar === "server" || !targetedCallers.has(callerKey)) {
        getPrefixes(callerKey).add("");
      }
    }

    // 2. Propagate mounts
    let changed = true;
    let iterations = 0;

    while (changed && iterations < 10) {
      changed = false;
      iterations++;

      for (const mount of mounts) {
        const callerKey = `${mount.relPath}#${mount.callerVar}`;
        const callerPrefixes = getPrefixes(callerKey);
        if (callerPrefixes.size === 0) continue;
        const basePrefixes = Array.from(callerPrefixes);

        // Check if targetVar is imported from another file
        const fileMap = fileImports.get(mount.relPath);
        const importedFile = fileMap?.get(mount.targetVar);

        const targetKeys: string[] = [];
        if (importedFile) {
          // Cross-file mount: target router in importedFile
          targetKeys.push(`${importedFile}#router`, `${importedFile}#default`, `${importedFile}#${mount.targetVar}`);
          // Also any router variable in importedFile
          for (const m of mounts) {
            if (m.relPath === importedFile) {
              targetKeys.push(`${importedFile}#${m.callerVar}`);
            }
          }
        } else {
          // Local mount in same file
          targetKeys.push(`${mount.relPath}#${mount.targetVar}`);
        }

        for (const targetKey of targetKeys) {
          const targetSet = getPrefixes(targetKey);
          for (const baseP of basePrefixes) {
            const combined = normalizeRouteUri(baseP, mount.prefix);
            if (!targetSet.has(combined)) {
              targetSet.add(combined);
              changed = true;
            }
          }
        }
      }
    }

    // Convert Set to Array
    const result = new Map<string, string[]>();
    for (const [k, set] of prefixes.entries()) {
      result.set(k, Array.from(set));
    }
    return result;
  }

  private findSourceFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist") {
          results.push(...this.findSourceFiles(full));
        } else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
          results.push(full);
        }
      }
    } catch {}
    return results;
  }
}

