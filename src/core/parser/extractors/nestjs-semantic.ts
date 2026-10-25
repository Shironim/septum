import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { isIgnoredDirectory } from "../../resources/ignore.ts";
import { parseWithTreeSitter } from "../wasm-loader.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import type Parser from "web-tree-sitter";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

const NEST_HTTP_METHODS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  All: "ALL",
  Head: "HEAD",
  Options: "OPTIONS",
};

interface ParsedDecorator {
  name: string;
  args: string[];
  startLine: number;
}

export class NestJsSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "nestjs";
  public readonly name = "NestJS Modular Semantic Extractor";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "nestjs") return true;

    if (fs.existsSync(path.join(projectRoot, "nest-cli.json"))) return true;

    const pkgPath = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readOptionalSourceFile(pkgPath, "utf-8"));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps["@nestjs/core"] || deps["@nestjs/common"]) return true;
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
    const srcDir = path.join(projectRoot, "src");
    if (!fs.existsSync(srcDir)) return slices;

    const resolver = new ImportResolver(projectRoot);
    const controllerFiles = this.findFilesRecursively(srcDir, /\.controller\.(ts|js)$/);

    for (const file of controllerFiles) {
      if (signal?.aborted) throw new Error("semantic_extraction_cancelled");
      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content.trim()) continue;

      const fileSlices = await parseWithTreeSitter(
        "typescript",
        content,
        (rootNode) => this.extractFromAst(file, relPath, content, rootNode, projectRoot, resolver, domainId)
      );

      if (fileSlices && fileSlices.length > 0) {
        slices.push(...fileSlices);
      }
    }

    return slices;
  }

  private extractFromAst(
    _filePath: string,
    relPath: string,
    content: string,
    rootNode: Parser.SyntaxNode,
    projectRoot: string,
    resolver: ImportResolver,
    domainId?: number
  ): VerticalSliceCandidate[] {
    const slices: VerticalSliceCandidate[] = [];
    const lines = content.split("\n");

    // Collect imports in controller file
    const importsMap = new Map<string, string>();
    for (const child of rootNode.namedChildren) {
      if (child.type === "import_statement") {
        const sourceNode = child.childForFieldName("source");
        const specifier = sourceNode ? sourceNode.text.replace(/^['"]|['"]$/g, "") : "";
        if (!specifier) continue;
        const importClause = child.namedChildren.find((c) => c.type === "import_clause");
        if (importClause) {
          for (const ic of importClause.namedChildren) {
            if (ic.type === "identifier") {
              importsMap.set(ic.text.trim(), specifier);
            } else if (ic.type === "namespace_import") {
              const idNode = ic.namedChildren.find((n) => n.type === "identifier");
              if (idNode) importsMap.set(idNode.text.trim(), specifier);
            } else if (ic.type === "named_imports") {
              for (const spec of ic.namedChildren) {
                if (spec.type === "import_specifier") {
                  const alias = spec.childForFieldName("alias");
                  const name = spec.childForFieldName("name") ?? spec.namedChildren[0];
                  const ident = alias ? alias.text.trim() : name ? name.text.trim() : "";
                  if (ident) importsMap.set(ident, specifier);
                }
              }
            }
          }
        }
      }
    }

    const walkForClasses = (node: Parser.SyntaxNode): void => {
      let classNode: Parser.SyntaxNode | null = null;
      let classDecorators: ParsedDecorator[] = [];

      if (node.type === "class_declaration") {
        classNode = node;
        classDecorators = node.namedChildren
          .filter((c) => c.type === "decorator")
          .map((c) => this.parseDecorator(c))
          .filter(Boolean) as ParsedDecorator[];
      } else if (node.type === "export_statement") {
        classDecorators = node.namedChildren
          .filter((c) => c.type === "decorator")
          .map((c) => this.parseDecorator(c))
          .filter(Boolean) as ParsedDecorator[];
        const innerClass = node.namedChildren.find((c) => c.type === "class_declaration");
        if (innerClass) {
          classNode = innerClass;
          const innerDecorators = innerClass.namedChildren
            .filter((c) => c.type === "decorator")
            .map((c) => this.parseDecorator(c))
            .filter(Boolean) as ParsedDecorator[];
          classDecorators.push(...innerDecorators);
        }
      }

      if (classNode) {
        const controllerDec = classDecorators.find((d) => d.name === "Controller");
        if (controllerDec) {
          const rawPrefix = controllerDec.args[0] ?? "";
          const routePrefix = rawPrefix ? `/${rawPrefix.replace(/^\/+|\/+$/g, "")}` : "";
          const nameNode = classNode.namedChildren.find((c) => c.type === "type_identifier" || c.type === "identifier");
          const controllerClass = nameNode ? nameNode.text.trim() : "AnonymousController";
          const classGuards = classDecorators.filter((d) => d.name === "UseGuards").flatMap((d) => d.args);

          this.processControllerClass(
            classNode,
            controllerClass,
            routePrefix,
            classGuards,
            relPath,
            lines,
            slices,
            importsMap,
            projectRoot,
            resolver,
            domainId
          );
        }
        return;
      }

      for (const child of node.namedChildren) {
        walkForClasses(child);
      }
    };

    walkForClasses(rootNode);
    return slices;
  }

  private processControllerClass(
    classNode: Parser.SyntaxNode,
    controllerClass: string,
    routePrefix: string,
    classGuards: string[],
    relPath: string,
    _lines: string[],
    slices: VerticalSliceCandidate[],
    importsMap: Map<string, string>,
    projectRoot: string,
    resolver: ImportResolver,
    domainId?: number
  ): void {
    const bodyNode =
      classNode.childForFieldName("body") ?? classNode.namedChildren.find((c) => c.type === "class_body");
    if (!bodyNode) return;

    // 1. Identify injected services from constructor
    const injectedServices = new Map<string, { type: string; line: number }>();

    for (const member of bodyNode.namedChildren) {
      if (member.type === "method_definition") {
        const nameNode =
          member.childForFieldName("name") ??
          member.namedChildren.find((c) => c.type === "property_identifier" || c.type === "identifier");
        if (nameNode?.text === "constructor") {
          const paramsNode =
            member.childForFieldName("parameters") ??
            member.namedChildren.find((c) => c.type === "formal_parameters");
          if (paramsNode) {
            for (const param of paramsNode.namedChildren) {
              if (param.type === "required_parameter" || param.type === "optional_parameter") {
                const hasAccessibility = param.namedChildren.some((c) => c.type === "accessibility_modifier");
                const hasReadonly = param.namedChildren.some((c) => c.type === "readonly");
                if (hasAccessibility || hasReadonly) {
                  const paramIdNode =
                    param.childForFieldName("pattern") ??
                    param.childForFieldName("name") ??
                    param.namedChildren.find((c) => c.type === "identifier");
                  const typeNode =
                    param.childForFieldName("type") ??
                    param.namedChildren.find((c) => c.type === "type_annotation");
                  if (paramIdNode && typeNode) {
                    const rawType = typeNode.text.replace(/^:\s*/, "").trim().split(/[<[{]/)[0].trim();
                    if (rawType && /^[A-Z]/.test(rawType)) {
                      injectedServices.set(paramIdNode.text.trim(), {
                        type: rawType,
                        line: param.startPosition.row + 1,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 2. Extract controller route actions with preceding decorators
    let pendingDecorators: ParsedDecorator[] = [];

    for (const member of bodyNode.namedChildren) {
      if (member.type === "decorator") {
        const dec = this.parseDecorator(member);
        if (dec) pendingDecorators.push(dec);
        continue;
      }

      if (member.type !== "method_definition") {
        pendingDecorators = [];
        continue;
      }

      const nameNode =
        member.childForFieldName("name") ??
        member.namedChildren.find((c) => c.type === "property_identifier" || c.type === "identifier");
      if (!nameNode || nameNode.text === "constructor") {
        pendingDecorators = [];
        continue;
      }

      const actionName = nameNode.text.trim();
      const actionLine = member.startPosition.row + 1;

      // Combine decorators attached to member and preceding decorators in class_body
      const memberAttachedDecorators = member.namedChildren
        .filter((c) => c.type === "decorator")
        .map((c) => this.parseDecorator(c))
        .filter(Boolean) as ParsedDecorator[];
      const methodDecorators = [...pendingDecorators, ...memberAttachedDecorators];
      pendingDecorators = [];

      const httpDec = methodDecorators.find((d) => NEST_HTTP_METHODS[d.name]);
      if (!httpDec) continue;

      const httpMethod = NEST_HTTP_METHODS[httpDec.name]!;
      const rawSub = httpDec.args[0] ?? "";
      const cleanSub = rawSub ? `/${rawSub.replace(/^\/+|\/+$/g, "")}` : "";
      const fullUri = `${routePrefix}${cleanSub}` || "/";
      const decoratorLine = httpDec.startLine || actionLine;

      // Method guards
      const methodGuards = methodDecorators.filter((d) => d.name === "UseGuards").flatMap((d) => d.args);
      const allGuards = Array.from(new Set([...classGuards, ...methodGuards]));

      // Extract DTO from @Body() parameter
      let validationDto: string | null = null;
      const paramsNode =
        member.childForFieldName("parameters") ??
        member.namedChildren.find((c) => c.type === "formal_parameters");
      if (paramsNode) {
        for (const param of paramsNode.namedChildren) {
          if (param.type === "required_parameter" || param.type === "optional_parameter") {
            const paramDecorators = param.namedChildren
              .filter((c) => c.type === "decorator")
              .map((c) => this.parseDecorator(c))
              .filter(Boolean) as ParsedDecorator[];
            if (paramDecorators.some((d) => d.name === "Body")) {
              const typeNode =
                param.childForFieldName("type") ?? param.namedChildren.find((c) => c.type === "type_annotation");
              if (typeNode) {
                const typeStr = typeNode.text.replace(/^:\s*/, "").trim().split(/[<[{]/)[0].trim();
                const primitiveTypes = new Set(["string", "number", "boolean", "any", "unknown", "object", "Record"]);
                if (typeStr && !primitiveTypes.has(typeStr)) {
                  validationDto = typeStr;
                }
              }
            }
          }
        }
      }

      // 3. Trace explicit service calls in method body
      interface ExplicitServiceCall {
        symbol: string;
        file: string;
        line: number;
        persistenceNodes: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }>;
      }
      const explicitCalls: ExplicitServiceCall[] = [];
      const methodBody =
        member.childForFieldName("body") ?? member.namedChildren.find((c) => c.type === "statement_block");
      if (methodBody) {
        const walkCalls = (bNode: Parser.SyntaxNode): void => {
          if (bNode.type === "call_expression") {
            const fnNode =
              bNode.childForFieldName("function") ??
              bNode.namedChildren.find((c) => c.type === "member_expression");
            if (fnNode && fnNode.type === "member_expression") {
              const objNode = fnNode.childForFieldName("object") ?? fnNode.namedChildren[0];
              const propNode = fnNode.childForFieldName("property") ?? fnNode.namedChildren[1];
              if (objNode && objNode.type === "member_expression") {
                const subObj = objNode.childForFieldName("object") ?? objNode.namedChildren[0];
                const subProp = objNode.childForFieldName("property") ?? objNode.namedChildren[1];
                if (subObj?.text === "this" && subProp && injectedServices.has(subProp.text)) {
                  const svc = injectedServices.get(subProp.text)!;
                  const callMethod = propNode ? propNode.text.trim() : "action";
                  let serviceFile: string | undefined;
                  let serviceLine = bNode.startPosition.row + 1;
                  const persistenceNodes: Array<{
                    stage: string;
                    symbol: string;
                    file?: string;
                    line?: number;
                    description?: string;
                  }> = [];

                  const importSpec = importsMap.get(svc.type);
                  if (importSpec) {
                    const res = resolver.resolve(importSpec, path.resolve(projectRoot, relPath));
                    if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
                      serviceFile = res.targets[0].files[0];
                      const fullServicePath = path.resolve(projectRoot, serviceFile);
                      const serviceContent = readOptionalSourceFile(fullServicePath, "utf-8");
                      if (serviceContent) {
                        const mMatch = new RegExp(`(?:async\\s+)?(?:public\\s+)?\\b${callMethod}\\s*\\(`).exec(serviceContent);
                        if (mMatch) {
                          serviceLine = serviceContent.slice(0, mMatch.index).split("\n").length;
                        }

                        // Inspect for TypeORM / Prisma / Mongoose persistence
                        const typeOrmMatch = serviceContent.match(
                          /@InjectRepository\s*\(\s*([A-Za-z0-9_]+)\s*\)|Repository<\s*([A-Za-z0-9_]+)\s*>/
                        );
                        const prismaMatch = serviceContent.match(
                          /this\.prisma\.([a-zA-Z0-9_]+)\.(?:find|create|update|delete|upsert)/
                        );
                        const mongooseMatch = serviceContent.match(/@InjectModel\s*\(\s*([A-Za-z0-9_]+)/);
                        const arMatch = serviceContent.match(
                          /\b([A-Z][a-zA-Z0-9_]+)\.(?:save|find|findOne|create|update|delete)\s*\(/
                        );

                        const entityName =
                          typeOrmMatch ? (typeOrmMatch[1] || typeOrmMatch[2]) :
                          prismaMatch ? (prismaMatch[1].charAt(0).toUpperCase() + prismaMatch[1].slice(1)) :
                          mongooseMatch ? mongooseMatch[1] :
                          arMatch && arMatch[1] !== svc.type ? arMatch[1] : undefined;

                        if (entityName) {
                          let entityFile: string | undefined;
                          const entImportMatch = serviceContent.match(
                            new RegExp(
                              `import\\s+(?:{[^}]*\\b${entityName}\\b[^}]*}|\\b${entityName}\\b)\\s+from\\s+['"]([^'"]+)['"]`
                            )
                          );
                          if (entImportMatch) {
                            const eRes = resolver.resolve(entImportMatch[1], fullServicePath);
                            if (eRes.status === "resolved" && eRes.targets[0]?.files?.[0]) {
                              entityFile = eRes.targets[0].files[0];
                            }
                          }

                          persistenceNodes.push({
                            stage: "repository",
                            symbol: `${entityName}Repository`,
                            file: serviceFile,
                            description: "TypeORM / Persistence Repository",
                          });
                          persistenceNodes.push({
                            stage: "entity",
                            symbol: entityName,
                            file: entityFile || serviceFile,
                            description: "Database Entity / Persistence Layer",
                          });
                        }
                      }
                    }
                  }

                  explicitCalls.push({
                    symbol: `${svc.type}::${callMethod}`,
                    file: serviceFile || relPath,
                    line: serviceFile ? serviceLine : bNode.startPosition.row + 1,
                    persistenceNodes,
                  });
                }
              }
            }
          }
          for (const c of bNode.namedChildren) {
            walkCalls(c);
          }
        };
        walkCalls(methodBody);
      }

      // 4. Construct execution chain
      const chain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
        {
          stage: "ingress",
          symbol: `${httpMethod} ${fullUri}`,
          file: relPath,
          line: decoratorLine,
          description: `NestJS Route: ${httpMethod} ${fullUri}`,
        },
      ];

      for (const guard of allGuards) {
        chain.push({
          stage: "guard",
          symbol: guard,
          file: relPath,
          line: actionLine,
          description: `NestJS Guard: ${guard}`,
        });
      }

      if (validationDto) {
        chain.push({
          stage: "validation",
          symbol: validationDto,
          description: "DTO Validation",
        });
      }

      chain.push({
        stage: "controller",
        symbol: `${controllerClass}::${actionName}`,
        file: relPath,
        line: actionLine,
        description: `NestJS Controller Action`,
      });

      for (const call of explicitCalls) {
        chain.push({
          stage: "service",
          symbol: call.symbol,
          file: call.file,
          line: call.line,
          description: `Injected Service Call`,
        });
        for (const pNode of call.persistenceNodes) {
          chain.push(pNode);
        }
      }

      slices.push({
        domain_id: domainId ?? null,
        feature_key: `nest.${controllerClass.toLowerCase().replace("controller", "")}.${actionName}`,
        http_method: httpMethod,
        route_uri: fullUri,
        route_name: `${controllerClass}.${actionName}`,
        controller_class: controllerClass,
        action_name: actionName,
        controller_file: relPath,
        controller_line: actionLine,
        architecture_style: "mvc",
        entry_kind: "http_route",
        execution_chain_json: JSON.stringify(chain),
      });
    }
  }

  private parseDecorator(node: Parser.SyntaxNode): ParsedDecorator | null {
    if (node.type !== "decorator") return null;
    const startLine = node.startPosition.row + 1;
    const first = node.namedChildren[0];
    if (!first) return null;

    if (first.type === "identifier") {
      return { name: first.text.trim(), args: [], startLine };
    }

    if (first.type === "call_expression") {
      const fnNode = first.childForFieldName("function") ?? first.namedChildren[0];
      const name = fnNode ? fnNode.text.trim() : "";
      const argsNode = first.childForFieldName("arguments") ?? first.namedChildren.find((c) => c.type === "arguments");
      const args: string[] = [];

      if (argsNode) {
        for (const arg of argsNode.namedChildren) {
          if (arg.type === "string" || arg.type === "template_string") {
            args.push(arg.text.replace(/^['"`]|['"`]$/g, "").trim());
          } else {
            args.push(arg.text.trim());
          }
        }
      }
      return { name, args, startLine };
    }

    return null;
  }

  private findFilesRecursively(dir: string, pattern: RegExp): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !isIgnoredDirectory(entry.name)) {
          results.push(...this.findFilesRecursively(full, pattern));
        } else if (entry.isFile() && pattern.test(entry.name)) {
          results.push(full);
        }
      }
    } catch {}
    return results;
  }
}
