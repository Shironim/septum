import * as fs from "node:fs";
import * as path from "node:path";
import type Parser from "web-tree-sitter";
import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { parseSourceWithTreeSitter } from "../wasm-loader.ts";
import { ImportResolver } from "../../resolver/import-resolver.ts";
import type {
  SemanticSliceExtractor,
  VerticalSliceCandidate,
} from "./semantic-extractor.interface.ts";
import type { ExecutionChainNode } from "../../../types/index.ts";

interface ParsedRouteAttribute {
  path: string;
  name?: string;
  methods: string[];
}

interface InjectedService {
  symbol: string;
  file?: string;
}

export class SymfonySemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "symfony";
  public readonly name = "Symfony Semantic Extractor";

  constructor(private projectRoot: string = process.cwd()) {}

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "symfony") return true;
    if (
      fs.existsSync(path.join(projectRoot, "bin/console")) ||
      fs.existsSync(path.join(projectRoot, "symfony.lock")) ||
      fs.existsSync(path.join(projectRoot, "config/routes.yaml"))
    ) {
      return true;
    }
    const composerJson = path.join(projectRoot, "composer.json");
    if (fs.existsSync(composerJson)) {
      try {
        const composer = JSON.parse(fs.readFileSync(composerJson, "utf-8"));
        const reqs = { ...(composer.require ?? {}), ...(composer["require-dev"] ?? {}) };
        if (
          reqs["symfony/framework-bundle"] ||
          reqs["symfony/symfony"] ||
          reqs["symfony/routing"]
        ) {
          return true;
        }
      } catch {}
    }
    return false;
  }

  public async extractSlices(
    projectRoot: string = this.projectRoot,
    domainId?: number,
    signal?: AbortSignal
  ): Promise<VerticalSliceCandidate[]> {
    const root = path.resolve(projectRoot);
    const controllerFiles = this.collectControllerFiles(root);
    const slices: VerticalSliceCandidate[] = [];
    const resolver = new ImportResolver(root);

    for (const file of controllerFiles) {
      signal?.throwIfAborted();
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content || !content.includes("#[Route")) continue;

      const relPath = path.relative(root, file).replace(/\\/g, "/");

      await parseSourceWithTreeSitter(
        "php",
        content,
        (rootNode) => {
          let currentNamespace = "";

          for (const node of rootNode.namedChildren) {
            signal?.throwIfAborted();

            if (node.type === "namespace_definition") {
              const nameNode = node.childForFieldName("name") ?? node.namedChildren.find((c) => c.type === "namespace_name");
              if (nameNode) currentNamespace = nameNode.text.replace(/^\\/, "");
              continue;
            }

            if (node.type === "class_declaration") {
              const nameNode = node.childForFieldName("name");
              if (!nameNode) continue;

              const shortClassName = nameNode.text;
              const fullClassName = currentNamespace ? `${currentNamespace}\\${shortClassName}` : shortClassName;

              // Check class-level #[Route] attribute
              const classAttr = this.extractRouteAttributeFromNode(node);
              const classPrefix = classAttr ? classAttr.path : "";
              const classNamePrefix = classAttr?.name ?? "";

              const bodyNode = node.childForFieldName("body");
              if (!bodyNode) continue;

              for (const member of bodyNode.namedChildren) {
                if (member.type !== "method_declaration") continue;

                const methodNameNode = member.childForFieldName("name");
                if (!methodNameNode) continue;
                const methodName = methodNameNode.text;
                const methodLine = member.startPosition.row + 1;

                const methodAttr = this.extractRouteAttributeFromNode(member);
                if (!methodAttr) continue;

                // Compose final URI
                const fullUri = this.composeUri(classPrefix, methodAttr.path);
                const fullRouteName = this.composeRouteName(classNamePrefix, methodAttr.name);
                const targetMethods = methodAttr.methods.length > 0 ? methodAttr.methods : ["GET"];

                // Extract injected services and request parameters
                const { requestParam, services } = this.extractParameters(member, root, file, resolver);

                for (const httpMethod of targetMethods) {
                  const chain: ExecutionChainNode[] = [
                    {
                      stage: "ingress",
                      symbol: `${httpMethod} ${fullUri}`,
                      file: relPath,
                      description: fullRouteName ? `HTTP Ingress: ${fullRouteName}` : `HTTP Ingress`,
                    },
                  ];

                  if (requestParam) {
                    chain.push({
                      stage: "validation",
                      symbol: requestParam,
                      file: relPath,
                      description: "Symfony Request Injection",
                    });
                  }

                  chain.push({
                    stage: "controller",
                    symbol: `${fullClassName}::${methodName}`,
                    file: relPath,
                    line: methodLine,
                    description: "Symfony Controller Action",
                  });

                  for (const svc of services) {
                    chain.push({
                      stage: "service",
                      symbol: svc.symbol,
                      file: svc.file,
                      description: "Domain Service Invocation",
                    });
                  }

                  // Egress
                  const returnTypeNode = member.childForFieldName("return_type");
                  const returnType = returnTypeNode?.text?.replace(/^:\s*/, "") || "Response";
                  chain.push({
                    stage: "egress",
                    symbol: returnType,
                    description: "HTTP Response Egress",
                  });

                  slices.push({
                    domain_id: domainId ?? 1,
                    feature_key: fullRouteName || null,
                    http_method: httpMethod,
                    route_uri: fullUri,
                    route_name: fullRouteName || null,
                    controller_class: fullClassName,
                    action_name: methodName,
                    controller_file: relPath,
                    controller_line: methodLine,
                    architecture_style: "mvc",
                    entry_kind: "http_route",
                    execution_chain_json: JSON.stringify(chain),
                  });
                }
              }
            }
          }
          return { symbols: [], dependencies: [] };
        },
        () => ({ symbols: [], dependencies: [] })
      );
    }

    return slices;
  }

  private collectControllerFiles(root: string): string[] {
    const files: string[] = [];
    const controllerDir = path.join(root, "src/Controller");

    const scanDir = (dir: string, depth = 0) => {
      if (depth > 5 || !fs.existsSync(dir)) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "vendor" || entry.name === "var" || entry.name === "tests") {
            continue;
          }
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (entry.isFile() && entry.name.endsWith(".php")) {
            files.push(fullPath);
          }
        }
      } catch {}
    };

    if (fs.existsSync(controllerDir)) {
      scanDir(controllerDir);
    } else {
      const srcDir = path.join(root, "src");
      if (fs.existsSync(srcDir)) {
        scanDir(srcDir);
      }
    }

    return files;
  }

  private extractRouteAttributeFromNode(node: Parser.SyntaxNode): ParsedRouteAttribute | null {
    const attrList = node.namedChildren.find((c) => c.type === "attribute_list");
    if (!attrList) return null;

    for (const group of attrList.namedChildren.filter((c) => c.type === "attribute_group")) {
      for (const attr of group.namedChildren.filter((c) => c.type === "attribute")) {
        const nameNode = attr.namedChildren.find((c) => c.type === "name");
        if (nameNode?.text !== "Route") continue;

        const argsNode = attr.namedChildren.find((c) => c.type === "arguments");
        if (!argsNode) return { path: "", methods: ["GET"] };

        let routePath = "";
        let routeName: string | undefined;
        const methods: string[] = [];

        for (const arg of argsNode.namedChildren.filter((c) => c.type === "argument")) {
          const argNameNode = arg.namedChildren.find((c) => c.type === "name");
          if (!argNameNode) {
            // Positional argument: path
            routePath = this.cleanLiteral(arg.namedChildren[0]?.text);
          } else {
            const argName = argNameNode.text;
            const valNode = arg.namedChildren[1];
            if (argName === "path") {
              routePath = this.cleanLiteral(valNode?.text);
            } else if (argName === "name") {
              routeName = this.cleanLiteral(valNode?.text);
            } else if (argName === "methods") {
              if (valNode?.type === "array_creation_expression") {
                for (const elem of valNode.namedChildren) {
                  const m = this.cleanLiteral(elem.text).toUpperCase();
                  if (m) methods.push(m);
                }
              } else if (valNode) {
                methods.push(this.cleanLiteral(valNode.text).toUpperCase());
              }
            }
          }
        }

        return {
          path: routePath,
          name: routeName,
          methods: methods.length > 0 ? methods : ["GET"],
        };
      }
    }

    return null;
  }

  private cleanLiteral(text?: string): string {
    if (!text) return "";
    const trimmed = text.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  private composeUri(classPrefix: string, methodPath: string): string {
    const cleanPrefix = classPrefix.replace(/^\/+|\/+$/g, "");
    const cleanPath = methodPath.replace(/^\/+|\/+$/g, "");

    if (!cleanPrefix && !cleanPath) return "/";
    if (!cleanPrefix) return `/${cleanPath}`;
    if (!cleanPath) return `/${cleanPrefix}`;
    return `/${cleanPrefix}/${cleanPath}`;
  }

  private composeRouteName(prefix?: string, name?: string): string | undefined {
    if (!prefix && !name) return undefined;
    if (!prefix) return name;
    if (!name) return prefix;
    return `${prefix}${name}`;
  }

  private extractParameters(
    methodNode: Parser.SyntaxNode,
    projectRoot: string,
    currentFile: string,
    resolver: ImportResolver
  ): { requestParam?: string; services: InjectedService[] } {
    const services: InjectedService[] = [];
    let requestParam: string | undefined;

    const paramsNode = methodNode.childForFieldName("parameters");
    if (!paramsNode) return { requestParam, services };

    for (const param of paramsNode.namedChildren) {
      if (param.type !== "simple_parameter") continue;
      const typeNode = param.childForFieldName("type");
      if (!typeNode) continue;

      const rawType = typeNode.text.replace(/^\\/, "").trim();
      const shortType = rawType.split("\\").pop() || rawType;

      if (/Request$/i.test(shortType)) {
        requestParam = shortType;
      } else if (/(Service|Repository|Handler|Manager|Client)$/i.test(shortType)) {
        let filePath: string | undefined;
        let fqn = rawType;
        if (!rawType.includes("\\")) {
          const fileContent = readOptionalSourceFile(currentFile, "utf-8");
          const useMatch = new RegExp(`use\\s+([^;]+?\\\\${rawType})(?:\\s+as\\s+[A-Za-z0-9_]+)?;`, "i").exec(fileContent);
          if (useMatch) {
            fqn = useMatch[1].trim();
          }
        }
        const res = resolver.resolve(fqn, currentFile);
        if (res.status === "resolved" && res.targets[0]?.files?.[0]) {
          filePath = res.targets[0].files[0];
        }
        services.push({
          symbol: shortType,
          file: filePath,
        });
      }
    }

    return { requestParam, services };
  }
}
