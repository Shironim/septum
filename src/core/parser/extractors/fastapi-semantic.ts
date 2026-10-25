import type Parser from "web-tree-sitter";
import { parseSourceWithTreeSitter } from "../wasm-loader.ts";
import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

interface ExtractedRoute {
  file: string;
  relPath: string;
  routerVar: string;
  httpMethod: string;
  rawPath: string;
  actionName: string;
  params: string;
  lineIndex: number;
  actionLine: number;
  validationSchema?: string;
  guardSymbol?: string;
  dependencies: string[];
  responseModel?: string;
  service?: { symbol: string; line: number };
  model?: string;
}

interface ExtractedInclusion {
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

function extractSchemaType(rawType: string): string | undefined {
  const clean = rawType.replace(/^(?:typing\.)?(?:Optional|List|Union)\[(.*)\]$/, "$1").trim();
  const name = clean.split(/[\[,|]/)[0].trim().replace(/^.*?\./, "");
  if (!name || !/^[A-Z]/.test(name)) return undefined;
  const builtins = new Set([
    "Str", "Int", "Float", "Bool", "Dict", "List", "Set", "Tuple", "Bytes",
    "Optional", "Any", "Union", "Request", "Response", "BackgroundTasks",
    "UploadFile", "Header", "Query", "Path", "Body", "Cookie", "Security", "Session", "Depends", "None"
  ]);
  if (builtins.has(name)) return undefined;
  return name;
}

function extractDependsFromNode(node: Parser.SyntaxNode | null | undefined, out: Array<{ symbol: string; isGuard: boolean }>): void {
  if (!node) return;
  const walk = (n: Parser.SyntaxNode) => {
    if (n.type === "call" && /Depends$/.test(n.childForFieldName("function")?.text ?? "")) {
      const arg = n.childForFieldName("arguments")?.namedChildren[0]?.text?.trim();
      if (arg) {
        const isGuard = /auth|user|token|permission|guard|role|credential/i.test(arg);
        out.push({ symbol: arg, isGuard });
      }
    }
    for (const child of n.namedChildren) walk(child);
  };
  walk(node);
}

export class FastApiSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "fastapi";
  public readonly name = "FastAPI Semantic Slice Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "fastapi") return true;

    // Check configuration manifests
    for (const manifest of ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"]) {
      const fullPath = path.join(projectRoot, manifest);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8").toLowerCase();
          if (content.includes("fastapi")) return true;
        } catch {}
      }
    }

    // Check entrypoint files
    for (const entry of ["main.py", "app.py", "api.py", "src/main.py", "app/main.py"]) {
      const fullPath = path.join(projectRoot, entry);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (content.includes("from fastapi") || content.includes("import fastapi")) {
            return true;
          }
        } catch {}
      }
    }

    return false;
  }

  public async extractSlices(projectRoot: string, domainId?: number, signal?: AbortSignal): Promise<VerticalSliceCandidate[]> {
    const slices: VerticalSliceCandidate[] = [];
    const pyFiles = this.findPythonFiles(projectRoot);
    const resolver = new ImportResolver(projectRoot);

    const allRoutes: ExtractedRoute[] = [];
    const allInclusions: ExtractedInclusion[] = [];
    const localRouters = new Map<
      string,
      { prefix: string; isApp: boolean; guards?: string[]; dependencies?: string[] }
    >();
    const fileImports = new Map<string, Map<string, ImportBinding>>();

    for (const file of pyFiles) {
      signal?.throwIfAborted();
      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content || (!content.includes("@") && !content.includes("include_router") && !content.includes("APIRouter") && !content.includes("FastAPI"))) {
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

        // 2. Collect router & app definitions
        walk(root, (node) => {
          if (node.type !== "assignment" || node.parent?.parent?.type !== "module") return;
          const leftName = node.childForFieldName("left")?.text ?? "";
          const call = node.childForFieldName("right");
          if (call?.type !== "call") return;
          const fnText = call.childForFieldName("function")?.text ?? "";
          const isRouter = /APIRouter$/.test(fnText);
          const isApp = /FastAPI$/.test(fnText);
          if (!isRouter && !isApp) return;

          const args = call.childForFieldName("arguments")?.namedChildren ?? [];
          const keyword = args.find(
            (child) => child.type === "keyword_argument" && child.childForFieldName("name")?.text === "prefix"
          );
          const prefix = cleanLiteral(keyword?.childForFieldName("value")) ?? "";

          // Router-level dependencies: router = APIRouter(dependencies=[Depends(...)])
          const depsKw = args.find(
            (child) => child.type === "keyword_argument" && child.childForFieldName("name")?.text === "dependencies"
          );
          const routerGuards: string[] = [];
          const routerDeps: string[] = [];
          if (depsKw) {
            const extracted: Array<{ symbol: string; isGuard: boolean }> = [];
            extractDependsFromNode(depsKw.childForFieldName("value"), extracted);
            for (const item of extracted) {
              if (item.isGuard) routerGuards.push(item.symbol);
              else routerDeps.push(item.symbol);
            }
          }

          localRouters.set(`${relPath}#${leftName}`, {
            prefix: prefix.replace(/\/+$/, ""),
            isApp,
            guards: routerGuards,
            dependencies: routerDeps,
          });
        });

        // 3. Collect include_router calls
        walk(root, (node) => {
          if (node.type !== "call") return;
          const fn = node.childForFieldName("function");
          if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "include_router") return;
          const parentVar = fn.childForFieldName("object")?.text ?? "";
          const args = node.childForFieldName("arguments")?.namedChildren ?? [];
          const firstArg = args[0];
          if (!firstArg || firstArg.type === "keyword_argument") return;

          const targetExpr = firstArg.text.trim();
          const prefixKw = args.find(
            (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "prefix"
          );
          const incPrefix = cleanLiteral(prefixKw?.childForFieldName("value")) ?? "";
          allInclusions.push({
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
            const method = attr.childForFieldName("attribute")?.text ?? "";
            if (!/^(get|post|put|patch|delete|options|head)$/.test(method)) continue;

            const args = call.childForFieldName("arguments")?.namedChildren ?? [];
            const rawPath = cleanLiteral(args[0]);
            if (rawPath === undefined) continue;

            const routerVar = attr.childForFieldName("object")?.text ?? "";
            const actionName = fn.childForFieldName("name")?.text ?? "";
            const paramsText = fn.childForFieldName("parameters")?.text ?? "";

            // Extract Pydantic validation schema from typed parameters
            let validationSchema: string | undefined;
            const paramsNode = fn.childForFieldName("parameters");
            if (paramsNode) {
              for (const param of paramsNode.namedChildren) {
                if (param.type === "typed_parameter" || param.type === "typed_default_parameter") {
                  const typeNode = param.childForFieldName("type");
                  if (typeNode) {
                    const detected = extractSchemaType(typeNode.text);
                    if (detected && !validationSchema) {
                      validationSchema = detected;
                    }
                  }
                }
              }
            }

            // Fallback schema regex
            if (!validationSchema) {
              const schemaMatch = paramsText.match(
                /[a-zA-Z0-9_]+\s*:\s*([A-Z][a-zA-Z0-9_]*(?:Schema|In|Request|Create|Update|DTO|Body))/
              );
              if (schemaMatch) validationSchema = schemaMatch[1];
            }

            // Extract guards and dependencies from Depends(...)
            let guardSymbol: string | undefined;
            const inboundDeps: string[] = [];
            if (paramsNode) {
              for (const param of paramsNode.namedChildren) {
                let valNode: Parser.SyntaxNode | null = null;
                if (param.type === "typed_default_parameter" || param.type === "default_parameter") {
                  valNode = param.childForFieldName("value");
                }
                if (valNode?.type === "call" && /Depends$/.test(valNode.childForFieldName("function")?.text ?? "")) {
                  const depArg = valNode.childForFieldName("arguments")?.namedChildren[0];
                  const sym = depArg?.text?.trim();
                  if (sym) {
                    if (/auth|user|token|permission|guard|role|credential/i.test(sym)) {
                      guardSymbol = sym;
                    } else {
                      inboundDeps.push(sym);
                    }
                  }
                }
              }
            }

            // Fallback guard regex
            if (!guardSymbol) {
              const guardMatch = paramsText.match(
                /Depends\s*\(\s*([a-zA-Z0-9_]*(?:auth|user|token|permission|guard)[a-zA-Z0-9_]*)\s*\)/i
              );
              if (guardMatch) guardSymbol = guardMatch[1];
            }

            // Extract dependencies from decorator: @router.get("/", dependencies=[Depends(...)])
            const decDepsKw = args.find(
              (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "dependencies"
            );
            if (decDepsKw) {
              const decExtracted: Array<{ symbol: string; isGuard: boolean }> = [];
              extractDependsFromNode(decDepsKw.childForFieldName("value"), decExtracted);
              for (const item of decExtracted) {
                if (item.isGuard && !guardSymbol) guardSymbol = item.symbol;
                else inboundDeps.push(item.symbol);
              }
            }

            // Extract response_model
            const rmKw = args.find(
              (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "response_model"
            );
            const responseModel = rmKw?.childForFieldName("value")?.text?.trim();

            const route: ExtractedRoute = {
              file,
              relPath,
              routerVar,
              httpMethod: method.toUpperCase(),
              rawPath,
              actionName,
              params: paramsText,
              lineIndex: decorator.startPosition.row + 1,
              actionLine: fn.startPosition.row + 1,
              validationSchema,
              guardSymbol,
              dependencies: inboundDeps,
              responseModel,
            };

            const body = fn.childForFieldName("body");
            if (body) {
              walk(body, (child) => {
                if (child.type !== "call") return;
                const called = child.childForFieldName("function")?.text ?? "";
                const service = called.match(/^([a-zA-Z0-9_]+_service|[A-Z][a-zA-Z0-9_]*Service)\.([a-zA-Z0-9_]+)$/);
                if (service && !route.service) {
                  route.service = { symbol: `${service[1]}::${service[2]}`, line: child.startPosition.row + 1 };
                }
                if (/^(db\.(add|query)|session\.query)$/.test(called)) {
                  const argument = child.childForFieldName("arguments")?.namedChildren[0];
                  if (argument?.type === "identifier" && /^[A-Z]/.test(argument.text)) {
                    route.model = argument.text;
                  }
                }
              });
            }

            allRoutes.push(route);
          }
        });

        return { symbols: [], dependencies: [] };
      });

      if (parsed?.status !== "parsed") {
        throw new Error(`FastAPI AST unavailable or degraded: ${relPath}`);
      }
    }

    // 5. Build Inclusion Graph and Resolve Cross-File Router Targets
    // Adjacency: parentKey -> Array<{ childKey: string; prefix: string }>
    const routerChildren = new Map<string, Array<{ childKey: string; prefix: string }>>();
    const incomingInclusions = new Map<string, Array<{ parentKey: string; prefix: string }>>();

    for (const inc of allInclusions) {
      const parentKey = `${inc.relPath}#${inc.parentVar}`;
      const importsInFile = fileImports.get(inc.relPath) ?? new Map<string, ImportBinding>();

      let targetKey: string | undefined;

      if (inc.targetExpr.includes(".")) {
        const [objName, propName] = inc.targetExpr.split(".");
        const binding = importsInFile.get(objName);
        if (binding) {
          // Try resolving submodule target first: e.g. from app.routers import orders -> orders.router
          const subTarget = binding.module ? `${binding.module}.${binding.symbol || objName}` : objName;
          let res = resolver.resolve(subTarget, inc.file);
          if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
            targetKey = `${res.targets[0].files[0]}#${propName}`;
          } else if (binding.module) {
            res = resolver.resolve(binding.module, inc.file);
            if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
              targetKey = `${res.targets[0].files[0]}#${propName}`;
            }
          }
        }
      } else {
        const binding = importsInFile.get(inc.targetExpr);
        if (binding) {
          // Try resolving submoduleTarget first (binding.module + "." + binding.symbol)
          const subTarget = binding.module && binding.symbol ? `${binding.module}.${binding.symbol}` : (binding.module || binding.symbol!);
          let res = resolver.resolve(subTarget, inc.file);
          if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
            targetKey = `${res.targets[0].files[0]}#router`;
          } else if (binding.module) {
            res = resolver.resolve(binding.module, inc.file);
            if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
              targetKey = `${res.targets[0].files[0]}#${binding.symbol || "router"}`;
            }
          }
        } else {
          // Local router inside same file
          const candidate = `${inc.relPath}#${inc.targetExpr}`;
          if (localRouters.has(candidate)) {
            targetKey = candidate;
          }
        }
      }

      if (targetKey) {
        if (!routerChildren.has(parentKey)) routerChildren.set(parentKey, []);
        routerChildren.get(parentKey)!.push({ childKey: targetKey, prefix: inc.prefix });

        if (!incomingInclusions.has(targetKey)) incomingInclusions.set(targetKey, []);
        incomingInclusions.get(targetKey)!.push({ parentKey, prefix: inc.prefix });
      }
    }

    // 6. Compute Effective Prefixes for Each Router
    // A router is a root if it has no incoming inclusions or is an explicit FastAPI app
    const effectivePrefixesByRouter = new Map<string, string[]>();

    const allRouterKeys = new Set<string>([
      ...localRouters.keys(),
      ...allRoutes.map((r) => `${r.relPath}#${r.routerVar}`),
    ]);

    // Find root routers
    for (const routerKey of allRouterKeys) {
      const incoming = incomingInclusions.get(routerKey);
      if (!incoming || incoming.length === 0) {
        const local = localRouters.get(routerKey)?.prefix ?? "";
        effectivePrefixesByRouter.set(routerKey, [local]);
      }
    }

    // Propagate prefixes along inclusion edges
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

        const childLocal = localRouters.get(child.childKey)?.prefix ?? "";
        const nextPrefixes = currentPrefixes.map((p) => {
          const combined = `${p ? (p.startsWith("/") ? p : `/${p}`) : ""}${child.prefix ? (child.prefix.startsWith("/") ? child.prefix : `/${child.prefix}`) : ""}${childLocal ? (childLocal.startsWith("/") ? childLocal : `/${childLocal}`) : ""}`;
          return combined.replace(/\/+/g, "/").replace(/\/+$/, "");
        });

        const existing = effectivePrefixesByRouter.get(child.childKey) ?? [];
        const merged = Array.from(new Set([...existing, ...nextPrefixes]));
        effectivePrefixesByRouter.set(child.childKey, merged);
        queue.push(child.childKey);
      }
    }

    // 7. Generate Vertical Slices
    for (const route of allRoutes) {
      const routerKey = `${route.relPath}#${route.routerVar}`;
      let prefixes = effectivePrefixesByRouter.get(routerKey);
      if (!prefixes || prefixes.length === 0) {
        prefixes = [localRouters.get(routerKey)?.prefix ?? ""];
      }

      for (const prefix of prefixes) {
        const fullUri = normalizeRouteUri(prefix, route.rawPath);

        const chain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
          {
            stage: "ingress",
            symbol: `${route.httpMethod} ${fullUri}`,
            file: route.relPath,
            line: route.lineIndex,
            description: `FastAPI Route: ${route.httpMethod} ${fullUri}`,
          },
        ];

        const routerMeta = localRouters.get(routerKey);
        const effectiveGuards = Array.from(new Set([
          ...(route.guardSymbol ? [route.guardSymbol] : []),
          ...(routerMeta?.guards ?? []),
        ]));
        const effectiveDeps = Array.from(new Set([
          ...route.dependencies,
          ...(routerMeta?.dependencies ?? []),
        ]));

        for (const guard of effectiveGuards) {
          chain.push({
            stage: "guard",
            symbol: guard,
            description: `Auth / Security Dependency: ${guard}`,
          });
        }

        if (route.validationSchema) {
          chain.push({
            stage: "validation",
            symbol: route.validationSchema,
            description: `Pydantic Schema Validation: ${route.validationSchema}`,
          });
        }

        const controllerSymbol = `${path.basename(route.file, ".py")}::${route.actionName}`;
        chain.push({
          stage: "controller",
          symbol: controllerSymbol,
          file: route.relPath,
          line: route.actionLine,
          description: `FastAPI Route Handler: ${route.actionName}`,
        });

        for (const dep of effectiveDeps) {
          chain.push({
            stage: "dependency",
            symbol: dep,
            description: `FastAPI Inbound Dependency: ${dep}`,
          });
        }

        if (route.service) {
          chain.push({
            stage: "service",
            symbol: route.service.symbol,
            file: route.relPath,
            line: route.service.line,
            description: "Syntactic member call; receiver binding and runtime execution unproven",
          });
        }

        if (route.model) {
          chain.push({
            stage: "model",
            symbol: route.model,
            description: "ORM argument hint; persistence unproven",
          });
        }

        if (route.responseModel) {
          chain.push({
            stage: "response_schema",
            symbol: route.responseModel,
            description: `FastAPI Response Model: ${route.responseModel}`,
          });
        }

        const evidencedChain = chain.map((node) => ({
          ...node,
          relationship: {
            kind:
              node.stage === "ingress" || node.stage === "controller"
                ? "route_binding"
                : node.stage === "validation" || node.stage === "model" || node.stage === "response_schema"
                ? "schema_binding"
                : "calls",
            derivation: node.file && node.line ? "source" : "inferred",
            source: node.file && node.line ? { file: node.file, line: node.line } : undefined,
            reason: node.description ?? "static adapter evidence",
          },
        }));

        slices.push({
          domain_id: domainId ?? null,
          feature_key: null,
          http_method: route.httpMethod,
          route_uri: fullUri,
          route_name: `${route.routerVar}.${route.actionName}`,
          controller_class: path.basename(route.file, ".py"),
          action_name: route.actionName,
          controller_file: route.relPath,
          controller_line: route.actionLine,
          architecture_style: "fastapi-api",
          entry_kind: "http_route",
          execution_chain_json: JSON.stringify(evidencedChain),
        });
      }
    }

    return slices;
  }

  private findPythonFiles(dir: string): string[] {
    const results: string[] = [];
    const ignored = new Set([
      "node_modules",
      ".git",
      ".venv",
      "venv",
      "env",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      "build",
      "dist",
    ]);

    const traverse = (currentDir: string) => {
      if (!fs.existsSync(currentDir)) return;
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".") && entry.name !== ".septum") continue;
          if (ignored.has(entry.name)) continue;

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

