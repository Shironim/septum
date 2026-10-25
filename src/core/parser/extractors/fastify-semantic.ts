import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { parseWithTreeSitter } from "../wasm-loader.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import type Parser from "web-tree-sitter";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

const FASTIFY_VERBS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "all",
  "head",
  "options",
]);

interface RawFastifyRoute {
  file: string;
  relPath: string;
  scopeId: string;
  httpMethods: string[];
  rawPath: string;
  hooks: Array<{ symbol: string; line: number }>;
  handler: { symbol: string; line: number };
  bodyDto?: string;
  schemaRef?: string;
  routeLine: number;
}

interface RawFastifyRegister {
  file: string;
  relPath: string;
  parentScopeId: string;
  targetPluginSymbol?: string;
  targetScopeId?: string;
  prefix: string;
  line: number;
}

interface KnownSchema {
  id: string;
  file: string;
  line: number;
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

export class FastifySemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "fastify";
  public readonly name = "Fastify Plugin Scoping Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "fastify") return true;

    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readOptionalSourceFile(pkgPath, "utf-8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps["fastify"]) return true;
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

    const allRoutes: RawFastifyRoute[] = [];
    const allRegisters: RawFastifyRegister[] = [];
    const knownSchemas = new Map<string, KnownSchema>();
    const fileImports = new Map<string, Map<string, string>>(); // relPath -> (importedIdent -> targetRelPath)
    const fileScopes = new Map<string, Set<string>>(); // relPath -> Set of scopeIds defined in file

    for (const file of sourceFiles) {
      if (signal?.aborted) throw new Error("semantic_extraction_cancelled");
      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
      const content = readOptionalSourceFile(file, "utf-8");
      if (
        !content ||
        (!content.includes("fastify") &&
          !content.includes("Fastify") &&
          !content.includes(".register") &&
          !content.includes(".route") &&
          !content.includes(".get") &&
          !content.includes(".post") &&
          !content.includes(".addSchema"))
      ) {
        continue;
      }

      const fileData = await parseWithTreeSitter(
        "typescript",
        content,
        (rootNode) => this.extractFileAst(file, relPath, rootNode, resolver)
      );

      if (fileData) {
        allRoutes.push(...fileData.routes);
        allRegisters.push(...fileData.registers);
        for (const [id, s] of fileData.schemas.entries()) {
          knownSchemas.set(id, s);
          // also normalize by stripping trailing '#'
          if (id.endsWith("#")) {
            knownSchemas.set(id.slice(0, -1), s);
          }
        }
        if (fileData.resolvedImports.size > 0) {
          fileImports.set(relPath, fileData.resolvedImports);
        }
        if (fileData.definedScopes.size > 0) {
          fileScopes.set(relPath, fileData.definedScopes);
        }
      }
    }

    // Resolve Scope Prefix DAG
    const scopePrefixes = this.resolveScopePrefixes(allRegisters, fileImports, fileScopes);

    // Build Vertical Slices
    for (const route of allRoutes) {
      const prefixes = scopePrefixes.get(route.scopeId) || [""];

      for (const prefix of prefixes) {
        for (const httpMethod of route.httpMethods) {
          const fullUri = normalizeRouteUri(prefix, route.rawPath);
          const actionSymbol = route.handler.symbol;
          const rootIdent = actionSymbol.includes(".") ? actionSymbol.split(".")[0] : actionSymbol;
          const resolvedControllerFile = fileImports.get(route.relPath)?.get(rootIdent) || route.relPath;
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
              description: `Fastify Route: ${httpMethod} ${fullUri}`,
            },
          ];

          // Schema / DTO stage
          if (route.bodyDto) {
            chain.push({
              stage: "validation",
              symbol: route.bodyDto,
              file: route.relPath,
              line: route.routeLine,
              description: `Fastify Body DTO: ${route.bodyDto}`,
            });
          }

          if (route.schemaRef) {
            const rawRef = route.schemaRef;
            const strippedRef = rawRef.endsWith("#") ? rawRef.slice(0, -1) : rawRef;
            const known = knownSchemas.get(rawRef) || knownSchemas.get(strippedRef);

            if (known) {
              chain.push({
                stage: "validation",
                symbol: known.id,
                file: known.file,
                line: known.line,
                description: `Resolved Fastify Schema: ${known.id}`,
              });
            } else {
              // Unresolved $ref: do not hallucinate models
              chain.push({
                stage: "validation",
                symbol: "unresolved:$ref",
                file: route.relPath,
                line: route.routeLine,
                description: `Unresolved schema reference: ${rawRef}`,
              });
            }
          }

          // Hooks / Middleware
          for (const hook of route.hooks) {
            chain.push({
              stage: "middleware",
              symbol: hook.symbol,
              file: route.relPath,
              line: hook.line,
              description: `Fastify Hook: ${hook.symbol}`,
            });
          }

          // Controller Action
          chain.push({
            stage: "controller",
            symbol: actionSymbol,
            file: resolvedControllerFile,
            line: route.handler.line,
            description: `Fastify Action Handler`,
          });

          slices.push({
            domain_id: domainId ?? null,
            feature_key: `fastify.${controllerClass.toLowerCase()}.${actionName}`,
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
    _filePath: string,
    relPath: string,
    rootNode: Parser.SyntaxNode,
    resolver: ImportResolver
  ): {
    routes: RawFastifyRoute[];
    registers: RawFastifyRegister[];
    schemas: Map<string, KnownSchema>;
    resolvedImports: Map<string, string>;
    definedScopes: Set<string>;
  } {
    const routes: RawFastifyRoute[] = [];
    const registers: RawFastifyRegister[] = [];
    const schemas = new Map<string, KnownSchema>();
    const resolvedImports = new Map<string, string>();
    const definedScopes = new Set<string>();

    definedScopes.add(`${relPath}#root`);

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

    // 2. Discover named functions / scopes in file
    const registerScope = (node: Parser.SyntaxNode): void => {
      if (node.type === "function_declaration") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          definedScopes.add(`${relPath}#${nameNode.text.trim()}`);
        }
      } else if (node.type === "variable_declarator") {
        const nameNode = node.childForFieldName("name");
        const initNode = node.childForFieldName("value");
        if (nameNode && initNode && (initNode.type === "arrow_function" || initNode.type === "function_expression" || initNode.type === "call_expression")) {
          definedScopes.add(`${relPath}#${nameNode.text.trim()}`);
        }
      } else if (node.type === "export_statement") {
        for (const child of node.namedChildren) {
          if (child.type === "function_declaration" || child.type === "arrow_function" || child.type === "function_expression") {
            definedScopes.add(`${relPath}#default`);
          }
        }
      }
      for (const child of node.namedChildren) {
        registerScope(child);
      }
    };
    registerScope(rootNode);

    // 3. Walk call expressions
    const walk = (node: Parser.SyntaxNode): void => {
      if (node.type === "call_expression") {
        const fnNode = node.childForFieldName("function");
        if (fnNode && fnNode.type === "member_expression") {
          const propNode = fnNode.childForFieldName("property");
          const argsNode = node.childForFieldName("arguments");

          if (propNode && argsNode) {
            const methodName = propNode.text.trim();
            const args = argsNode.namedChildren;
            const currentScopeId = this.findEnclosingScope(node, relPath);

            // A. app.addSchema({ $id: "userSchema", ... })
            if (methodName === "addSchema" && args.length >= 1) {
              const schemaId = this.extractSchemaId(args[0]);
              if (schemaId) {
                schemas.set(schemaId, {
                  id: schemaId,
                  file: relPath,
                  line: node.startPosition.row + 1,
                });
              }
            }

            // B. app.register(plugin, { prefix: "/api" })
            else if (methodName === "register" && args.length >= 1) {
              const pluginArg = this.unwrapPluginNode(args[0]);
              let prefix = "";
              if (args.length >= 2 && args[1].type === "object") {
                prefix = this.extractObjectPropertyString(args[1], "prefix") ?? "";
              }

              if (pluginArg) {
                if (pluginArg.type === "identifier") {
                  registers.push({
                    file: relPath,
                    relPath,
                    parentScopeId: currentScopeId,
                    targetPluginSymbol: pluginArg.text.trim(),
                    prefix,
                    line: node.startPosition.row + 1,
                  });
                } else if (pluginArg.type === "arrow_function" || pluginArg.type === "function_expression") {
                  const inlineScopeId = `${relPath}#inline_${pluginArg.startPosition.row + 1}_${pluginArg.startPosition.column}`;
                  definedScopes.add(inlineScopeId);
                  registers.push({
                    file: relPath,
                    relPath,
                    parentScopeId: currentScopeId,
                    targetScopeId: inlineScopeId,
                    prefix,
                    line: node.startPosition.row + 1,
                  });
                }
              }
            }

            // C. fastify.route({ method: 'GET', url: '/path', handler: ... })
            else if (methodName === "route" && args.length >= 1 && args[0].type === "object") {
              const routeObj = args[0];
              const rawMethods = this.extractRouteMethods(routeObj);
              const rawPath = this.extractObjectPropertyString(routeObj, "url") ?? this.extractObjectPropertyString(routeObj, "path");

              if (rawPath !== undefined && rawMethods.length > 0) {
                const handler = this.extractHandlerFromRoute(routeObj, args[1]);
                const hooks = this.extractHooksFromOptions(routeObj);
                const { schemaRef, bodyDto } = this.extractSchemaFromRoute(node, routeObj);

                routes.push({
                  file: relPath,
                  relPath,
                  scopeId: currentScopeId,
                  httpMethods: rawMethods,
                  rawPath,
                  hooks,
                  handler,
                  bodyDto,
                  schemaRef,
                  routeLine: node.startPosition.row + 1,
                });
              }
            }

            // D. Shorthand methods: fastify.get('/path', [opts], handler)
            else if (FASTIFY_VERBS.has(methodName.toLowerCase())) {
              const httpMethod = methodName.toUpperCase();
              if (args.length >= 2) {
                const rawPath = cleanLiteral(args[0]);
                if (rawPath !== undefined) {
                  let handlerNode = args[args.length - 1];
                  let optsNode: Parser.SyntaxNode | undefined;
                  const hooks: Array<{ symbol: string; line: number }> = [];

                  if (args.length === 2) {
                    if (args[1].type === "object") {
                      optsNode = args[1];
                      const innerHandler = this.findObjectPropertyNode(args[1], "handler");
                      if (innerHandler) handlerNode = innerHandler;
                    }
                  } else {
                    optsNode = args[1];
                  }

                  if (optsNode) {
                    hooks.push(...this.extractHooksFromOptions(optsNode));
                  }

                  const handler = this.extractSingleHandler(handlerNode);
                  const { schemaRef, bodyDto } = this.extractSchemaFromRoute(node, optsNode);

                  routes.push({
                    file: relPath,
                    relPath,
                    scopeId: currentScopeId,
                    httpMethods: [httpMethod],
                    rawPath,
                    hooks,
                    handler,
                    bodyDto,
                    schemaRef,
                    routeLine: node.startPosition.row + 1,
                  });
                }
              }
            }
          }
        }
      }

      for (const child of node.namedChildren) {
        walk(child);
      }
    };

    walk(rootNode);

    return { routes, registers, schemas, resolvedImports, definedScopes };
  }

  private unwrapPluginNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
    // Unwraps fp(...) or fastifyPlugin(...) wrapper
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn && (fn.text.trim() === "fp" || fn.text.trim() === "fastifyPlugin")) {
        const args = node.childForFieldName("arguments");
        if (args && args.namedChildren.length > 0) {
          return args.namedChildren[0];
        }
      }
    }
    return node;
  }

  private findEnclosingScope(node: Parser.SyntaxNode, relPath: string): string {
    let curr: Parser.SyntaxNode | null = node.parent;
    while (curr) {
      if (curr.type === "function_declaration") {
        const name = curr.childForFieldName("name");
        if (name) return `${relPath}#${name.text.trim()}`;
        if (curr.parent?.type === "export_statement") return `${relPath}#default`;
      } else if (curr.type === "variable_declarator") {
        const name = curr.childForFieldName("name");
        if (name) return `${relPath}#${name.text.trim()}`;
      } else if (curr.type === "arrow_function" || curr.type === "function_expression") {
        if (curr.parent?.type === "export_statement") return `${relPath}#default`;
        if (curr.parent?.type === "arguments") {
          const call = curr.parent.parent;
          if (call && call.type === "call_expression") {
            const callFn = call.childForFieldName("function");
            if (callFn?.type === "member_expression" && callFn.childForFieldName("property")?.text.trim() === "register") {
              return `${relPath}#inline_${curr.startPosition.row + 1}_${curr.startPosition.column}`;
            }
          }
        }
      }
      curr = curr.parent;
    }
    return `${relPath}#root`;
  }

  private extractSchemaId(node: Parser.SyntaxNode): string | undefined {
    if (node.type === "object") {
      return this.extractObjectPropertyString(node, "$id");
    }
    return undefined;
  }

  private extractRouteMethods(routeObj: Parser.SyntaxNode): string[] {
    const prop = this.findObjectPropertyNode(routeObj, "method");
    if (!prop) return ["GET"];

    if (prop.type === "string") {
      const val = cleanLiteral(prop);
      return val ? [val.toUpperCase()] : ["GET"];
    }

    if (prop.type === "array") {
      const methods: string[] = [];
      for (const el of prop.namedChildren) {
        const val = cleanLiteral(el);
        if (val) methods.push(val.toUpperCase());
      }
      return methods.length > 0 ? methods : ["GET"];
    }

    return ["GET"];
  }

  private extractHandlerFromRoute(
    routeObj: Parser.SyntaxNode,
    secondaryArg?: Parser.SyntaxNode
  ): { symbol: string; line: number } {
    const handlerNode = this.findObjectPropertyNode(routeObj, "handler") ?? secondaryArg;
    if (handlerNode) {
      return this.extractSingleHandler(handlerNode);
    }
    return { symbol: "closure", line: routeObj.startPosition.row + 1 };
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

  private extractHooksFromOptions(optsNode: Parser.SyntaxNode): Array<{ symbol: string; line: number }> {
    const hooks: Array<{ symbol: string; line: number }> = [];
    if (optsNode.type !== "object") return hooks;

    for (const hookName of ["preHandler", "onRequest", "preValidation", "preSerialization"]) {
      const hookProp = this.findObjectPropertyNode(optsNode, hookName);
      if (hookProp) {
        if (hookProp.type === "array") {
          for (const el of hookProp.namedChildren) {
            hooks.push(this.extractSingleHandler(el));
          }
        } else {
          hooks.push(this.extractSingleHandler(hookProp));
        }
      }
    }

    return hooks;
  }

  private extractSchemaFromRoute(
    callNode: Parser.SyntaxNode,
    optsNode?: Parser.SyntaxNode
  ): { schemaRef?: string; bodyDto?: string } {
    let schemaRef: string | undefined;
    let bodyDto: string | undefined;

    // 1. Check TypeScript type arguments: fastify.post<{ Body: CreateUserDto }>(...)
    const typeArgs = callNode.childForFieldName("type_arguments");
    if (typeArgs) {
      for (const child of typeArgs.namedChildren) {
        if (child.type === "type_literal" || child.type === "object_type") {
          for (const prop of child.namedChildren) {
            if (prop.type === "property_signature") {
              const nameNode = prop.childForFieldName("name");
              const typeNode = prop.childForFieldName("type");
              if (nameNode && nameNode.text.trim().toLowerCase() === "body" && typeNode) {
                // typeNode is type_annotation -> type_identifier
                const ident = typeNode.namedChildren.find((c) => c.type === "type_identifier") ?? typeNode;
                const dtoName = ident.text.trim().replace(/^:\s*/, "");
                if (dtoName) bodyDto = dtoName;
              }
            }
          }
        }
      }
    }

    // 2. Check options.schema.body.$ref
    if (optsNode && optsNode.type === "object") {
      const schemaNode = this.findObjectPropertyNode(optsNode, "schema");
      if (schemaNode && schemaNode.type === "object") {
        const bodyProp = this.findObjectPropertyNode(schemaNode, "body");
        if (bodyProp && bodyProp.type === "object") {
          schemaRef = this.extractObjectPropertyString(bodyProp, "$ref");
        } else {
          const directRef = this.extractObjectPropertyString(schemaNode, "$ref");
          if (directRef) schemaRef = directRef;
        }
      }
    }

    return { schemaRef, bodyDto };
  }

  private findObjectPropertyNode(objNode: Parser.SyntaxNode, key: string): Parser.SyntaxNode | undefined {
    if (objNode.type !== "object") return undefined;
    for (const child of objNode.namedChildren) {
      if (child.type === "pair") {
        const keyNode = child.childForFieldName("key");
        if (keyNode) {
          const k = cleanLiteral(keyNode) ?? keyNode.text.trim();
          if (k === key) {
            return child.childForFieldName("value") ?? undefined;
          }
        }
      }
    }
    return undefined;
  }

  private extractObjectPropertyString(objNode: Parser.SyntaxNode, key: string): string | undefined {
    const valNode = this.findObjectPropertyNode(objNode, key);
    return cleanLiteral(valNode);
  }

  private resolveScopePrefixes(
    registers: RawFastifyRegister[],
    fileImports: Map<string, Map<string, string>>,
    fileScopes: Map<string, Set<string>>
  ): Map<string, string[]> {
    // Map: scopeId -> Set of prefix strings
    const prefixes = new Map<string, Set<string>>();

    const getPrefixes = (key: string): Set<string> => {
      let set = prefixes.get(key);
      if (!set) {
        set = new Set<string>();
        prefixes.set(key, set);
      }
      return set;
    };

    // 1. Identify all parent scopes that register children or top-level roots
    const childScopes = new Set<string>();

    for (const reg of registers) {
      let targetScopeId = reg.targetScopeId;
      if (!targetScopeId && reg.targetPluginSymbol) {
        const importedFile = fileImports.get(reg.relPath)?.get(reg.targetPluginSymbol);
        if (importedFile) {
          targetScopeId = `${importedFile}#${reg.targetPluginSymbol}`;
          // If imported target does not have exact symbol scope, alias to default or first scope in file
          const targets = fileScopes.get(importedFile);
          if (targets && !targets.has(targetScopeId)) {
            if (targets.has(`${importedFile}#default`)) {
              targetScopeId = `${importedFile}#default`;
            } else {
              targetScopeId = Array.from(targets)[0];
            }
          }
        } else {
          // Local symbol in same file
          targetScopeId = `${reg.relPath}#${reg.targetPluginSymbol}`;
        }
      }

      if (targetScopeId) {
        childScopes.add(targetScopeId);
      }
    }

    // 2. Root scopes: any scope with no incoming registers, or any #root scope
    for (const scopes of fileScopes.values()) {
      for (const sc of scopes) {
        if (!childScopes.has(sc) || sc.endsWith("#root")) {
          getPrefixes(sc).add("");
        }
      }
    }

    // 3. Propagate prefixes along registers
    let changed = true;
    let iterations = 0;

    while (changed && iterations < 15) {
      changed = false;
      iterations++;

      for (const reg of registers) {
        let targetScopeId = reg.targetScopeId;
        if (!targetScopeId && reg.targetPluginSymbol) {
          const importedFile = fileImports.get(reg.relPath)?.get(reg.targetPluginSymbol);
          if (importedFile) {
            targetScopeId = `${importedFile}#${reg.targetPluginSymbol}`;
            const targets = fileScopes.get(importedFile);
            if (targets && !targets.has(targetScopeId)) {
              if (targets.has(`${importedFile}#default`)) {
                targetScopeId = `${importedFile}#default`;
              } else if (targets.size > 0) {
                targetScopeId = Array.from(targets)[0];
              }
            }
          } else {
            targetScopeId = `${reg.relPath}#${reg.targetPluginSymbol}`;
          }
        }

        if (!targetScopeId) continue;

        const parentPrefixes = getPrefixes(reg.parentScopeId);
        const basePrefixes = parentPrefixes.size > 0 ? Array.from(parentPrefixes) : [""];
        const targetSet = getPrefixes(targetScopeId);

        for (const baseP of basePrefixes) {
          const combined = normalizeRouteUri(baseP, reg.prefix);
          if (!targetSet.has(combined)) {
            targetSet.add(combined);
            changed = true;
          }
        }
      }
    }

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

