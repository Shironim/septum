import type Parser from "web-tree-sitter";
import { parseSourceWithTreeSitter } from "../wasm-loader.ts";
import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

interface ViewMethodInfo {
  method: string;
  action: string;
  line: number;
  isCustomAction?: boolean;
  isDetail?: boolean;
}

interface ViewInfo {
  file: string;
  relPath: string;
  line: number;
  kind: "cbv" | "fbv" | "viewset";
  serializer?: string;
  model?: string;
  methods: ViewMethodInfo[];
}

interface RouterRegistration {
  urlFile: string;
  prefix: string;
  viewName: string;
  basename?: string;
  line: number;
}

interface PathRoute {
  urlFile: string;
  pattern: string;
  viewName: string;
  isAsView: boolean;
  routeName?: string;
  line: number;
}

interface UrlInclusion {
  parentUrlFile: string;
  pattern: string;
  targetModule: string;
  line: number;
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

function normalizeUri(prefix: string, sub: string): string {
  const p = (prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  const s = (sub ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!p && !s) return "/";
  if (!p) return `/${s}`;
  if (!s) return `/${p}`;
  return `/${p}/${s}`;
}

function cleanRoutePattern(raw: string): string {
  return raw
    .replace(/^\^+|\$+$/g, "")
    .replace(/\(\?P<([a-zA-Z0-9_]+)>[^)]+\)/g, "{$1}")
    .replace(/<([a-zA-Z0-9_]+:[a-zA-Z0-9_]+)>/g, (_match, p) => `{${p.split(":").pop()}}`)
    .replace(/<([a-zA-Z0-9_]+)>/g, "{$1}");
}

export class DjangoSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "django";
  public readonly name = "Django / DRF Semantic Slice Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "django") return true;

    if (
      fs.existsSync(path.join(projectRoot, "manage.py")) ||
      fs.existsSync(path.join(projectRoot, "wsgi.py")) ||
      fs.existsSync(path.join(projectRoot, "asgi.py"))
    ) {
      return true;
    }

    for (const manifest of ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"]) {
      const fullPath = path.join(projectRoot, manifest);
      if (fs.existsSync(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8").toLowerCase();
          if (content.includes("django")) return true;
        } catch {}
      }
    }

    return false;
  }

  public async extractSlices(projectRoot: string, domainId?: number, signal?: AbortSignal): Promise<VerticalSliceCandidate[]> {
    const slices: VerticalSliceCandidate[] = [];
    const pyFiles = this.findPythonFiles(projectRoot);
    const resolver = new ImportResolver(projectRoot);

    const viewsMap = new Map<string, ViewInfo>();
    const routerRegistrations: RouterRegistration[] = [];
    const pathRoutes: PathRoute[] = [];
    const urlInclusions: UrlInclusion[] = [];

    // 1. Locate and parse all views across Python files using Tree-sitter AST
    for (const file of pyFiles) {
      signal?.throwIfAborted();
      const fileName = path.basename(file);
      const isCandidate =
        fileName.includes("view") ||
        fileName.includes("api") ||
        fileName.includes("urls");

      const content = readOptionalSourceFile(file, "utf-8");
      if (!content) continue;

      const hasViewClues =
        content.includes("ViewSet") ||
        content.includes("APIView") ||
        content.includes("View") ||
        content.includes("api_view") ||
        content.includes("router.register") ||
        content.includes("urlpatterns");

      if (!isCandidate && !hasViewClues) continue;

      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");

      const parsed = await parseSourceWithTreeSitter("python", content, (root) => {
        const walk = (node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void) => {
          visit(node);
          for (const child of node.namedChildren) walk(child, visit);
        };

        // A. Class-Based Views and ViewSets
        walk(root, (node) => {
          if (node.type !== "class_definition") return;
          const nameNode = node.childForFieldName("name");
          if (!nameNode) return;
          const className = nameNode.text.trim();
          const classLine = node.startPosition.row + 1;

          const superNode = node.childForFieldName("superclasses");
          const baseClasses: string[] = [];
          if (superNode) {
            for (const child of superNode.namedChildren) {
              baseClasses.push(child.text.trim());
            }
          }

          const isViewSet = baseClasses.some((b) => /ViewSet/i.test(b));
          const isCbv = isViewSet || baseClasses.some((b) => /View/i.test(b));

          let serializer: string | undefined;
          let model: string | undefined;
          const explicitMethods: Array<{
            method: string;
            action: string;
            line: number;
            isCustomAction?: boolean;
            isDetail?: boolean;
          }> = [];

          const body = node.childForFieldName("body");
          if (body) {
            for (const child of body.namedChildren) {
              if (child.type === "expression_statement") {
                const assign = child.namedChildren[0];
                if (assign?.type === "assignment") {
                  const left = assign.childForFieldName("left")?.text?.trim();
                  const right = assign.childForFieldName("right");
                  if (left === "serializer_class") {
                    serializer = right?.text?.trim();
                  } else if (left === "model") {
                    model = right?.text?.trim();
                  } else if (left === "queryset" && right) {
                    let cur = right.type === "call" ? right.childForFieldName("function") : right;
                    while (cur?.type === "attribute") {
                      cur = cur.childForFieldName("object");
                    }
                    if (cur?.type === "identifier" && /^[A-Z]/.test(cur.text)) {
                      model = cur.text;
                    }
                  }
                }
              } else if (child.type === "function_definition") {
                const fnName = child.childForFieldName("name")?.text?.trim();
                const fnLine = child.startPosition.row + 1;
                if (!fnName) continue;

                if (isViewSet) {
                  const actionMap: Record<string, string> = {
                    list: "GET",
                    create: "POST",
                    retrieve: "GET",
                    update: "PUT",
                    partial_update: "PATCH",
                    destroy: "DELETE",
                  };
                  if (actionMap[fnName]) {
                    explicitMethods.push({ method: actionMap[fnName], action: fnName, line: fnLine });
                  }
                } else {
                  if (/^(get|post|put|patch|delete|options|head)$/.test(fnName)) {
                    explicitMethods.push({ method: fnName.toUpperCase(), action: fnName, line: fnLine });
                  }
                }
              } else if (child.type === "decorated_definition") {
                const defNode = child.childForFieldName("definition");
                if (defNode?.type === "function_definition") {
                  const fnName = defNode.childForFieldName("name")?.text?.trim();
                  const fnLine = defNode.startPosition.row + 1;
                  if (fnName && isViewSet) {
                    for (const dec of child.namedChildren.filter((c) => c.type === "decorator")) {
                      const decCall = dec.namedChildren[0];
                      if (decCall?.type === "call" && decCall.childForFieldName("function")?.text?.endsWith("action")) {
                        const args = decCall.childForFieldName("arguments")?.namedChildren ?? [];
                        const detailKw = args.find(
                          (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "detail"
                        );
                        const isDetail = detailKw?.childForFieldName("value")?.text?.toLowerCase() === "true";
                        const methodsKw = args.find(
                          (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "methods"
                        );
                        const actMethods: string[] = [];
                        if (methodsKw) {
                          const val = methodsKw.childForFieldName("value");
                          if (val?.type === "list") {
                            for (const m of val.namedChildren) {
                              const lit = cleanLiteral(m)?.toUpperCase();
                              if (lit) actMethods.push(lit);
                            }
                          }
                        }
                        if (actMethods.length === 0) actMethods.push("GET");
                        for (const method of actMethods) {
                          explicitMethods.push({ method, action: fnName, line: fnLine, isCustomAction: true, isDetail });
                        }
                      }
                    }
                  }
                }
              }
            }
          }

          const methods: ViewMethodInfo[] = [];

          if (isViewSet) {
            const fullCrud = baseClasses.some((b) => /\bModelViewSet\b/.test(b));
            const readOnly = baseClasses.some((b) => /\bReadOnlyModelViewSet\b/.test(b));
            const hasListMixin = baseClasses.some((b) => /\bListModelMixin\b/.test(b));
            const hasCreateMixin = baseClasses.some((b) => /\bCreateModelMixin\b/.test(b));
            const hasRetrieveMixin = baseClasses.some((b) => /\bRetrieveModelMixin\b/.test(b));
            const hasUpdateMixin = baseClasses.some((b) => /\bUpdateModelMixin\b/.test(b));
            const hasDestroyMixin = baseClasses.some((b) => /\bDestroyModelMixin\b/.test(b));

            const defaultActions: Array<[string, string, boolean]> = [
              ["GET", "list", fullCrud || readOnly || hasListMixin],
              ["POST", "create", fullCrud || hasCreateMixin],
              ["GET", "retrieve", fullCrud || readOnly || hasRetrieveMixin],
              ["PUT", "update", fullCrud || hasUpdateMixin],
              ["PATCH", "partial_update", fullCrud || hasUpdateMixin],
              ["DELETE", "destroy", fullCrud || hasDestroyMixin],
            ];

            for (const [method, action, allowed] of defaultActions) {
              const explicit = explicitMethods.find((m) => m.action === action && !m.isCustomAction);
              if (explicit) {
                methods.push(explicit);
              } else if (allowed) {
                methods.push({ method, action, line: classLine });
              }
            }

            for (const custom of explicitMethods.filter((m) => m.isCustomAction)) {
              methods.push(custom);
            }
          } else {
            methods.push(...explicitMethods);
          }

          if (methods.length > 0 || isViewSet || serializer || model || isCbv) {
            viewsMap.set(className, {
              file,
              relPath,
              line: classLine,
              kind: isViewSet ? "viewset" : "cbv",
              serializer,
              model,
              methods,
            });
          }
        });

        // B. Function-Based Views with @api_view
        walk(root, (node) => {
          if (node.type !== "decorated_definition") return;
          const fn = node.childForFieldName("definition");
          if (fn?.type !== "function_definition") return;
          const fnName = fn.childForFieldName("name")?.text?.trim();
          if (!fnName) return;
          const fnLine = fn.startPosition.row + 1;

          for (const decorator of node.namedChildren.filter((c) => c.type === "decorator")) {
            const call = decorator.namedChildren[0];
            if (call?.type !== "call") continue;
            const fnExpr = call.childForFieldName("function")?.text?.trim();
            if (fnExpr !== "api_view" && fnExpr !== "rest_framework.decorators.api_view") continue;

            const listArg = call.childForFieldName("arguments")?.namedChildren[0];
            const httpMethods: string[] = [];
            if (listArg?.type === "list") {
              for (const item of listArg.namedChildren) {
                const m = cleanLiteral(item)?.toUpperCase();
                if (m) httpMethods.push(m);
              }
            }

            if (httpMethods.length > 0) {
              viewsMap.set(fnName, {
                file,
                relPath,
                line: fnLine,
                kind: "fbv",
                methods: httpMethods.map((m) => ({ method: m, action: fnName, line: fnLine })),
              });
            }
          }
        });

        // C. URLConf: router.register, path(), and re_path()
        walk(root, (node) => {
          if (node.type !== "call") return;
          const fn = node.childForFieldName("function");
          const args = node.childForFieldName("arguments")?.namedChildren ?? [];

          // router.register(r'orders', OrderViewSet, basename='order')
          if (fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "register") {
            const firstArg = args[0];
            const secondArg = args[1];
            if (firstArg && secondArg) {
              const prefix = cleanLiteral(firstArg);
              if (prefix !== undefined) {
                const viewName = secondArg.text.trim().split(".").pop() || secondArg.text.trim();
                const bnKw = args.find(
                  (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "basename"
                );
                const basename = cleanLiteral(bnKw?.childForFieldName("value"));
                routerRegistrations.push({
                  urlFile: relPath,
                  prefix,
                  viewName,
                  basename,
                  line: node.startPosition.row + 1,
                });
              }
            }
            return;
          }

          // path('api/checkout/', CheckoutView.as_view(), name='checkout')
          // path('api/', include('orders.urls'))
          const fnName = fn?.text?.trim();
          if (fnName === "path" || fnName === "re_path") {
            const firstArg = args[0];
            const secondArg = args[1];
            if (!firstArg || !secondArg) return;

            const pattern = cleanLiteral(firstArg);
            if (pattern === undefined) return;

            const nameKw = args.find(
              (c) => c.type === "keyword_argument" && c.childForFieldName("name")?.text === "name"
            );
            const routeName = cleanLiteral(nameKw?.childForFieldName("value"));

            // Check if secondArg is include(...)
            if (secondArg.type === "call" && secondArg.childForFieldName("function")?.text?.endsWith("include")) {
              const incArgs = secondArg.childForFieldName("arguments")?.namedChildren ?? [];
              let incTarget: string | undefined;
              if (incArgs[0]?.type === "string") {
                incTarget = cleanLiteral(incArgs[0]);
              } else if (incArgs[0]?.type === "tuple" || incArgs[0]?.type === "list") {
                incTarget = cleanLiteral(incArgs[0].namedChildren[0]);
              }
              if (incTarget) {
                urlInclusions.push({
                  parentUrlFile: relPath,
                  pattern,
                  targetModule: incTarget,
                  line: node.startPosition.row + 1,
                });
              }
              return;
            }

            // Check if secondArg is View.as_view() or FBV
            let isAsView = false;
            let targetView = secondArg.text.trim();
            if (secondArg.type === "call") {
              const callFn = secondArg.childForFieldName("function");
              if (callFn?.type === "attribute" && callFn.childForFieldName("attribute")?.text === "as_view") {
                isAsView = true;
                targetView = callFn.childForFieldName("object")?.text?.trim() || targetView;
              }
            }
            targetView = targetView.split(".").pop() || targetView;

            pathRoutes.push({
              urlFile: relPath,
              pattern,
              viewName: targetView,
              isAsView,
              routeName,
              line: node.startPosition.row + 1,
            });
          }
        });

        return { symbols: [], dependencies: [] };
      });

      if (parsed?.status !== "parsed") {
        throw new Error(`Django AST unavailable or degraded: ${relPath}`);
      }
    }

    // 2. Resolve Multi-file URLConf Inclusions (path('api/', include('orders.urls')))
    const urlParentMap = new Map<string, Array<{ parentFile: string; prefix: string }>>();
    for (const inc of urlInclusions) {
      const parentAbs = path.resolve(projectRoot, inc.parentUrlFile);
      const res = resolver.resolve(inc.targetModule, parentAbs);
      if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
        const targetRel = res.targets[0].files[0];
        if (!urlParentMap.has(targetRel)) urlParentMap.set(targetRel, []);
        urlParentMap.get(targetRel)!.push({ parentFile: inc.parentUrlFile, prefix: inc.pattern });
      }
    }

    // Compute effective prefix for each urls.py file
    const urlPrefixesByFile = new Map<string, string[]>();
    const allUrlFiles = new Set<string>([
      ...routerRegistrations.map((r) => r.urlFile),
      ...pathRoutes.map((p) => p.urlFile),
      ...urlInclusions.map((i) => i.parentUrlFile),
    ]);

    for (const uFile of allUrlFiles) {
      const parents = urlParentMap.get(uFile);
      if (!parents || parents.length === 0) {
        urlPrefixesByFile.set(uFile, [""]);
      }
    }

    const queue = Array.from(urlPrefixesByFile.keys());
    const visitedIncs = new Set<string>();

    while (queue.length > 0) {
      const currentFile = queue.shift()!;
      const currentPrefixes = urlPrefixesByFile.get(currentFile) ?? [""];

      // Check children included by currentFile
      for (const [targetFile, parents] of urlParentMap.entries()) {
        for (const p of parents) {
          if (p.parentFile === currentFile) {
            const edgeKey = `${currentFile}->${targetFile}:${p.prefix}`;
            if (visitedIncs.has(edgeKey)) continue;
            visitedIncs.add(edgeKey);

            const nextPrefixes = currentPrefixes.map((cp) => normalizeUri(cp, p.prefix));
            const existing = urlPrefixesByFile.get(targetFile) ?? [];
            const merged = Array.from(new Set([...existing, ...nextPrefixes]));
            urlPrefixesByFile.set(targetFile, merged);
            queue.push(targetFile);
          }
        }
      }
    }

    // 3. Generate Vertical Slices from DRF Router Registrations
    for (const reg of routerRegistrations) {
      const prefixes = urlPrefixesByFile.get(reg.urlFile) ?? [""];
      const viewInfo = viewsMap.get(reg.viewName);
      if (!viewInfo) continue;

      for (const pfx of prefixes) {
        const routePrefix = normalizeUri(pfx, reg.prefix);

        for (const m of viewInfo.methods) {
          const uriSuffix = m.isCustomAction
            ? (m.isDetail ? `/{id}/${m.action}` : `/${m.action}`)
            : (m.action === "list" || m.action === "create" ? "" : "/{id}");
          const fullUri = `${routePrefix === "/" ? "" : routePrefix}${uriSuffix}` || "/";

          const chain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
            {
              stage: "ingress",
              symbol: `${m.method} ${fullUri}`,
              file: reg.urlFile,
              line: reg.line,
              description: `Django / DRF Route: ${m.method} ${fullUri}`,
            },
          ];

          if (viewInfo.serializer) {
            chain.push({
              stage: "validation",
              symbol: viewInfo.serializer,
              description: "DRF Serializer Validation",
            });
          }

          chain.push({
            stage: "controller",
            symbol: `${reg.viewName}::${m.action}`,
            file: viewInfo.relPath,
            line: m.line,
            description:
              m.isCustomAction
                ? "DRF ViewSet Custom Action"
                : m.line === viewInfo.line
                ? "Inherited DRF action (inferred from base class or mixin; line points to class)"
                : "DRF ViewSet Action",
          });

          if (viewInfo.model) {
            chain.push({
              stage: "model",
              symbol: viewInfo.model,
              description: "Django ORM Model",
            });
          }

          const evidencedChain = chain.map((node) => ({
            ...node,
            relationship: {
              kind:
                node.stage === "ingress" || node.stage === "controller"
                  ? "route_binding"
                  : node.stage === "validation" || node.stage === "model"
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
            http_method: m.method,
            route_uri: fullUri,
            route_name: `${reg.viewName}.${m.action}`,
            controller_class: reg.viewName,
            action_name: m.action,
            controller_file: viewInfo.relPath,
            controller_line: m.line,
            architecture_style: "django-drf",
            entry_kind: "http_route",
            execution_chain_json: JSON.stringify(evidencedChain),
          });
        }
      }
    }

    // 4. Generate Vertical Slices from path() & re_path() Routes
    for (const route of pathRoutes) {
      const prefixes = urlPrefixesByFile.get(route.urlFile) ?? [""];
      const viewInfo = viewsMap.get(route.viewName);
      if (!viewInfo || viewInfo.methods.length === 0) continue;

      for (const pfx of prefixes) {
        const fullUri = normalizeUri(pfx, cleanRoutePattern(route.pattern));

        for (const m of viewInfo.methods) {
          const chain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
            {
              stage: "ingress",
              symbol: `${m.method} ${fullUri}`,
              file: route.urlFile,
              line: route.line,
              description: `Django Route: ${m.method} ${fullUri}`,
            },
          ];

          if (viewInfo.serializer) {
            chain.push({
              stage: "validation",
              symbol: viewInfo.serializer,
              description: "Serializer Validation",
            });
          }

          chain.push({
            stage: "controller",
            symbol: `${route.viewName}::${m.action}`,
            file: viewInfo.relPath,
            line: m.line,
            description:
              viewInfo.kind === "viewset" && m.line === viewInfo.line
                ? "Inherited DRF action (inferred from base class or mixin; line points to class)"
                : "Django View Handler",
          });

          if (viewInfo.model) {
            chain.push({
              stage: "model",
              symbol: viewInfo.model,
              description: "Django Model",
            });
          }

          const evidencedChain = chain.map((node) => ({
            ...node,
            relationship: {
              kind:
                node.stage === "ingress" || node.stage === "controller"
                  ? "route_binding"
                  : node.stage === "validation" || node.stage === "model"
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
            http_method: m.method,
            route_uri: fullUri,
            route_name: route.routeName || `${route.viewName}.${m.action}`,
            controller_class: route.viewName,
            action_name: m.action,
            controller_file: viewInfo.relPath,
            controller_line: m.line,
            architecture_style: "django-mvc",
            entry_kind: "http_route",
            execution_chain_json: JSON.stringify(evidencedChain),
          });
        }
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

