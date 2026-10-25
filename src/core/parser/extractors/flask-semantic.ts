import type Parser from "web-tree-sitter";
import { parseSourceWithTreeSitter } from "../wasm-loader.ts";
import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { isIgnoredDirectory } from "../../resources/ignore.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

interface ExtractedFlaskRoute {
  file: string;
  relPath: string;
  routerVar: string;
  httpMethods: string[];
  rawPath: string;
  actionName: string;
  endpoint?: string;
  lineIndex: number;
  actionLine: number;
  templateEgress?: string;
}

interface ExtractedBlueprintRegistration {
  file: string;
  relPath: string;
  parentVar: string;
  targetExpr: string;
  prefix: string;
  line: number;
}

interface ImportBinding {
  module: string;
  symbol?: string;
}

function cleanLiteral(node: Parser.SyntaxNode | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "string") {
    const raw = node.text.trim();
    const match = raw.match(/^[rRbBuU]*('''|"""|'|")([\s\S]*?)\1$/);
    if (match) return match[2];
    return raw.replace(/^[rRbBuU]*['"]|['"]$/g, "");
  }
  return undefined;
}

function normalizeRouteUri(prefix: string, rawPath: string): string {
  const p = (prefix ?? "").trim().replace(/\/+$/, "");
  let r = (rawPath ?? "").trim();
  if (!r.startsWith("/")) r = "/" + r;
  if (r === "/" && p.length > 0) return p + "/";
  if (r === "/" && p.length === 0) return "/";
  const joined = `${p}${r}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

export class FlaskSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "flask";
  public readonly name = "Flask Semantic Slice Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "flask") return true;

    // Check configuration manifests
    for (const manifest of ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"]) {
      const fullPath = path.join(projectRoot, manifest);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8").toLowerCase();
          if (content.includes("flask")) return true;
        } catch {}
      }
    }

    // Check entrypoint files
    for (const entry of ["app.py", "main.py", "wsgi.py", "run.py", "server.py", "src/app.py", "app/__init__.py"]) {
      const fullPath = path.join(projectRoot, entry);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (content.includes("from flask") || content.includes("import flask")) {
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
    const pyFiles = this.findPythonFiles(projectRoot);
    const resolver = new ImportResolver(projectRoot);

    const allRoutes: ExtractedFlaskRoute[] = [];
    const allRegistrations: ExtractedBlueprintRegistration[] = [];
    const localBlueprints = new Map<
      string,
      { bpName: string; prefix: string; isApp: boolean }
    >();
    const fileImports = new Map<string, Map<string, ImportBinding>>();

    for (const file of pyFiles) {
      signal?.throwIfAborted();
      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
      const content = readOptionalSourceFile(file, "utf-8");
      if (
        !content ||
        (!content.includes("@") &&
          !content.includes("register_blueprint") &&
          !content.includes("Blueprint") &&
          !content.includes("Flask"))
      ) {
        continue;
      }

      const importsInFile = new Map<string, ImportBinding>();
      fileImports.set(relPath, importsInFile);

      const parsed = await parseSourceWithTreeSitter("python", content, (root) => {
        const walk = (node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void) => {
          visit(node);
          for (const child of node.namedChildren) walk(child, visit);
        };

        // 1. Collect import statements
        walk(root, (node) => {
          if (node.type === "import_statement") {
            for (const child of node.namedChildren) {
              if (child.type === "dotted_name") {
                const mod = child.text.trim();
                const alias = mod.split(".").pop() || mod;
                importsInFile.set(alias, { module: mod });
              } else if (child.type === "aliased_import") {
                const orig = child.childForFieldName("name")?.text?.trim();
                const alias = child.childForFieldName("alias")?.text?.trim();
                if (orig && alias) {
                  importsInFile.set(alias, { module: orig });
                }
              }
            }
          } else if (node.type === "import_from_statement") {
            const moduleName = node.childForFieldName("module_name")?.text?.trim() || "";
            for (const child of node.namedChildren) {
              if (child === node.childForFieldName("module_name")) continue;
              if (child.type === "dotted_name") {
                const sym = child.text.trim();
                importsInFile.set(sym, { module: moduleName || sym, symbol: sym });
              } else if (child.type === "aliased_import") {
                const orig = child.childForFieldName("name")?.text?.trim();
                const alias = child.childForFieldName("alias")?.text?.trim();
                if (orig && alias) {
                  importsInFile.set(alias, { module: moduleName || orig, symbol: orig });
                }
              }
            }
          }
        });

        // 2. Collect Flask App and Blueprint instantiations
        walk(root, (node) => {
          if (node.type !== "assignment" || node.parent?.parent?.type !== "module") return;
          const leftName = node.childForFieldName("left")?.text ?? "";
          const call = node.childForFieldName("right");
          if (call?.type !== "call") return;
          const fnText = call.childForFieldName("function")?.text ?? "";
          const isBlueprint = /Blueprint$/.test(fnText);
          const isApp = /Flask$/.test(fnText);
          if (!isBlueprint && !isApp) return;

          const args = call.childForFieldName("arguments")?.namedChildren ?? [];
          let bpName = leftName;
          let prefix = "";

          if (isBlueprint && args.length > 0) {
            const firstArg = args[0];
            if (firstArg.type !== "keyword_argument") {
              const lit = cleanLiteral(firstArg);
              if (lit) bpName = lit;
            }
          }

          const prefixKw = args.find(
            (child) => child.type === "keyword_argument" && child.childForFieldName("name")?.text === "url_prefix"
          );
          if (prefixKw) {
            prefix = cleanLiteral(prefixKw.childForFieldName("value")) ?? "";
          }

          localBlueprints.set(`${relPath}#${leftName}`, {
            bpName,
            prefix: prefix.replace(/\/+$/, ""),
            isApp,
          });
        });

        // 3. Collect register_blueprint calls
        walk(root, (node) => {
          if (node.type !== "call") return;
          const fn = node.childForFieldName("function");
          if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "register_blueprint") return;
          const parentVar = fn.childForFieldName("object")?.text ?? "";
          const args = node.childForFieldName("arguments")?.namedChildren ?? [];
          const firstArg = args[0];
          if (!firstArg || firstArg.type === "keyword_argument") return;

          const targetExpr = firstArg.text.trim();
          const prefixKw = args.find(
            (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "url_prefix"
          );
          const incPrefix = cleanLiteral(prefixKw?.childForFieldName("value")) ?? "";
          allRegistrations.push({
            file,
            relPath,
            parentVar,
            targetExpr,
            prefix: incPrefix.replace(/\/+$/, ""),
            line: node.startPosition.row + 1,
          });
        });

        // 4. Collect route handler definitions
        walk(root, (node) => {
          if (node.type !== "decorated_definition" || node.parent?.type !== "module") return;
          const fn = node.childForFieldName("definition");
          if (fn?.type !== "function_definition") return;

          for (const decorator of node.namedChildren.filter((child) => child.type === "decorator")) {
            const call = decorator.namedChildren[0];
            const attr = call?.childForFieldName("function");
            if (call?.type !== "call" || attr?.type !== "attribute") continue;

            const decoratorMethod = attr.childForFieldName("attribute")?.text ?? "";
            const isRoute = decoratorMethod === "route";
            const isShorthand = /^(get|post|put|patch|delete|options|head)$/i.test(decoratorMethod);
            if (!isRoute && !isShorthand) continue;

            const args = call.childForFieldName("arguments")?.namedChildren ?? [];
            const rawPath = cleanLiteral(args[0]);
            if (rawPath === undefined) continue;

            const routerVar = attr.childForFieldName("object")?.text ?? "";
            const actionName = fn.childForFieldName("name")?.text ?? "";

            // Determine HTTP methods
            let httpMethods: string[] = [];
            if (isRoute) {
              const methodsKw = args.find(
                (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "methods"
              );
              if (methodsKw) {
                const val = methodsKw.childForFieldName("value");
                if (val && (val.type === "list" || val.type === "tuple")) {
                  for (const m of val.namedChildren) {
                    const lit = cleanLiteral(m)?.toUpperCase();
                    if (lit) httpMethods.push(lit);
                  }
                }
              }
              if (httpMethods.length === 0) {
                httpMethods = ["GET"];
              }
            } else {
              httpMethods = [decoratorMethod.toUpperCase()];
            }

            // Extract optional endpoint
            const endpointKw = args.find(
              (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "endpoint"
            );
            const endpoint = cleanLiteral(endpointKw?.childForFieldName("value"));

            // Check function body for template render egress
            let templateEgress: string | undefined;
            const body = fn.childForFieldName("body");
            if (body) {
              walk(body, (child) => {
                if (child.type === "call") {
                  const calledFn = child.childForFieldName("function")?.text ?? "";
                  if (calledFn === "render_template") {
                    const tmplArg = child.childForFieldName("arguments")?.namedChildren[0];
                    const tmpl = cleanLiteral(tmplArg);
                    if (tmpl && !templateEgress) {
                      templateEgress = tmpl;
                    }
                  }
                }
              });
            }

            allRoutes.push({
              file,
              relPath,
              routerVar,
              httpMethods,
              rawPath,
              actionName,
              endpoint,
              lineIndex: decorator.startPosition.row + 1,
              actionLine: fn.startPosition.row + 1,
              templateEgress,
            });
          }
        });

        return { symbols: [], dependencies: [] };
      });

      if (parsed?.status !== "parsed") {
        throw new Error(`Flask AST parsing degraded in file: ${relPath}`);
      }
    }

    // 5. Build Inclusion Graph and Resolve Cross-File Blueprint Targets
    const routerChildren = new Map<string, Array<{ childKey: string; prefix: string }>>();
    const incomingRegistrations = new Map<string, Array<{ parentKey: string; prefix: string }>>();

    for (const reg of allRegistrations) {
      const parentKey = `${reg.relPath}#${reg.parentVar}`;
      const importsInFile = fileImports.get(reg.relPath) ?? new Map<string, ImportBinding>();

      let targetKey: string | undefined;

      if (reg.targetExpr.includes(".")) {
        const [objName, propName] = reg.targetExpr.split(".");
        const binding = importsInFile.get(objName);
        if (binding) {
          const subTarget = binding.module ? `${binding.module}.${binding.symbol || objName}` : objName;
          let res = resolver.resolve(subTarget, reg.file);
          if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
            targetKey = `${res.targets[0].files[0]}#${propName}`;
          } else if (binding.module) {
            res = resolver.resolve(binding.module, reg.file);
            if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
              targetKey = `${res.targets[0].files[0]}#${propName}`;
            }
          }
        }
      } else {
        const binding = importsInFile.get(reg.targetExpr);
        if (binding) {
          const subTarget =
            binding.module && binding.symbol ? `${binding.module}.${binding.symbol}` : binding.module || binding.symbol!;
          let res = resolver.resolve(subTarget, reg.file);
          if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
            targetKey = `${res.targets[0].files[0]}#${binding.symbol || reg.targetExpr}`;
          } else if (binding.module) {
            res = resolver.resolve(binding.module, reg.file);
            if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
              targetKey = `${res.targets[0].files[0]}#${binding.symbol || reg.targetExpr}`;
            }
          }
        } else {
          // Local blueprint inside same file
          const candidate = `${reg.relPath}#${reg.targetExpr}`;
          if (localBlueprints.has(candidate)) {
            targetKey = candidate;
          }
        }
      }

      if (targetKey) {
        if (!routerChildren.has(parentKey)) routerChildren.set(parentKey, []);
        routerChildren.get(parentKey)!.push({ childKey: targetKey, prefix: reg.prefix });

        if (!incomingRegistrations.has(targetKey)) incomingRegistrations.set(targetKey, []);
        incomingRegistrations.get(targetKey)!.push({ parentKey, prefix: reg.prefix });
      }
    }

    // 6. Compute Effective Prefixes for Each Router/Blueprint
    const effectivePrefixesByRouter = new Map<string, string[]>();

    const allRouterKeys = new Set<string>([
      ...localBlueprints.keys(),
      ...allRoutes.map((r) => `${r.relPath}#${r.routerVar}`),
    ]);

    // Find root routers
    for (const routerKey of allRouterKeys) {
      const incoming = incomingRegistrations.get(routerKey);
      if (!incoming || incoming.length === 0) {
        const local = localBlueprints.get(routerKey)?.prefix ?? "";
        effectivePrefixesByRouter.set(routerKey, [local]);
      }
    }

    // Propagate prefixes along registration edges via BFS
    const queue = Array.from(effectivePrefixesByRouter.keys());
    const visitedEdges = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentPrefixes = effectivePrefixesByRouter.get(current) ?? [""];
      const children = routerChildren.get(current) ?? [];

      for (const child of children) {
        const edgeKey = `${current}->${child.childKey}:${child.prefix}`;
        if (visitedEdges.has(edgeKey)) continue;
        visitedEdges.add(edgeKey);

        const childLocal = localBlueprints.get(child.childKey)?.prefix ?? "";
        const nextPrefixes = currentPrefixes.map((p) => {
          const combined = `${p ? (p.startsWith("/") ? p : `/${p}`) : ""}${
            child.prefix ? (child.prefix.startsWith("/") ? child.prefix : `/${child.prefix}`) : ""
          }${childLocal ? (childLocal.startsWith("/") ? childLocal : `/${childLocal}`) : ""}`;
          return combined.replace(/\/+/g, "/").replace(/\/+$/, "");
        });

        const existing = effectivePrefixesByRouter.get(child.childKey) ?? [];
        const merged = Array.from(new Set([...existing, ...nextPrefixes]));
        effectivePrefixesByRouter.set(child.childKey, merged);
        queue.push(child.childKey);
      }
    }

    // 7. Generate Vertical Slices (Level 0 – Level 3)
    for (const route of allRoutes) {
      const routerKey = `${route.relPath}#${route.routerVar}`;
      let prefixes = effectivePrefixesByRouter.get(routerKey);
      if (!prefixes || prefixes.length === 0) {
        prefixes = [localBlueprints.get(routerKey)?.prefix ?? ""];
      }

      const bpMeta = localBlueprints.get(routerKey);
      const controllerClass = bpMeta?.bpName || path.basename(route.file, ".py");

      for (const prefix of prefixes) {
        const fullUri = normalizeRouteUri(prefix, route.rawPath);

        for (const httpMethod of route.httpMethods) {
          const chain: Array<{
            stage: string;
            symbol: string;
            file?: string;
            line?: number;
            description?: string;
          }> = [
            {
              stage: "ingress",
              symbol: `${httpMethod} ${fullUri}`,
              file: route.relPath,
              line: route.lineIndex,
              description: `Flask Route: ${httpMethod} ${fullUri}`,
            },
            {
              stage: "controller",
              symbol: `${controllerClass}::${route.actionName}`,
              file: route.relPath,
              line: route.actionLine,
              description: `Flask View Handler: ${route.actionName}`,
            },
          ];

          if (route.templateEgress) {
            chain.push({
              stage: "egress",
              symbol: route.templateEgress,
              description: "Flask Template Render",
            });
          }

          const routeName = route.endpoint || (bpMeta ? `${bpMeta.bpName}.${route.actionName}` : route.actionName);

          slices.push({
            domain_id: domainId ?? null,
            feature_key: null,
            http_method: httpMethod,
            route_uri: fullUri,
            route_name: routeName,
            controller_class: controllerClass,
            action_name: route.actionName,
            controller_file: route.relPath,
            controller_line: route.actionLine,
            architecture_style: "flask",
            entry_kind: "http_route",
            execution_chain_json: JSON.stringify(chain),
          });
        }
      }
    }

    return slices;
  }

  private findPythonFiles(dir: string): string[] {
    const results: string[] = [];
    const traverse = (currentDir: string) => {
      if (!fs.existsSync(currentDir)) return;
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (isIgnoredDirectory(entry.name)) continue;

          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            traverse(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(".py")) {
            results.push(fullPath);
          }
        }
      } catch {}
    };

    traverse(dir);
    return results;
  }
}

