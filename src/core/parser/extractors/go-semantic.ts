import { readOptionalSourceFile } from "../../resources/source-files.ts";
import { isIgnoredDirectory } from "../../resources/ignore.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

export class GoSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "golang";
  public readonly name = "Go HTTP Semantic Slice Extractor (Gin, Echo, Chi)";

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (
      framework === "gin" ||
      framework === "echo" ||
      framework === "chi" ||
      framework === "fiber" ||
      framework === "generic-go" ||
      framework === "go" ||
      framework === "net/http"
    ) {
      return true;
    }

    const goMod = path.join(projectRoot, "go.mod");
    if (fs.existsSync(goMod)) {
      return true;
    }

    // Check Go source files for HTTP framework or standard library imports
    const goFiles = this.findGoFiles(projectRoot, 3);
    for (const file of goFiles) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        if (
          content.includes("github.com/gin-gonic/gin") ||
          content.includes("github.com/labstack/echo") ||
          content.includes("github.com/go-chi/chi") ||
          content.includes("github.com/gofiber/fiber") ||
          content.includes('"net/http"')
        ) {
          return true;
        }
      } catch {}
    }

    return false;
  }

  public extractSlices(projectRoot: string, domainId?: number): VerticalSliceCandidate[] {
    const slices: VerticalSliceCandidate[] = [];
    const goFiles = this.findGoFiles(projectRoot);

    interface HandlerInfo {
      name: string;
      receiver?: string;
      file: string;
      relPath: string;
      line: number;
      boundDto?: string;
      serviceCall?: string;
      repoCall?: string;
    }

    interface GoStructInfo {
      name: string;
      file: string;
      relPath: string;
      line: number;
      fields: Map<string, string>;
    }

    interface GoMethodInfo {
      receiver?: string;
      name: string;
      file: string;
      relPath: string;
      line: number;
      body: string;
      params?: string;
    }

    // 1. Catalog all handler functions & methods across .go files
    const handlers = new Map<string, HandlerInfo>();
    const goStructs = new Map<string, GoStructInfo>();
    const goMethods = new Map<string, GoMethodInfo>();

    for (const file of goFiles) {
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content) continue;

      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");

      // Match Go functions and methods:
      // func (h *OrderHandler) CreateOrder(c *gin.Context)
      // func (h OrderHandler) CreateOrder(c echo.Context) error
      // func CreateOrder(w http.ResponseWriter, r *http.Request)
      const funcRegex =
        /func\s*(?:\(\s*[a-zA-Z0-9_]+\s+\*?(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)\s*\)\s*)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)(?:[^{]*)\{/g;
      let fMatch: RegExpExecArray | null;

      while ((fMatch = funcRegex.exec(content)) !== null) {
        const receiver = fMatch[1];
        const fnName = fMatch[2];
        const params = fMatch[3];

        // Only catalog HTTP handlers (takes *gin.Context, echo.Context, http.ResponseWriter, *fiber.Ctx)
        const isHttpHandler =
          params.includes("gin.Context") ||
          params.includes("echo.Context") ||
          params.includes("http.ResponseWriter") ||
          params.includes("fiber.Ctx") ||
          params.includes("*http.Request");

        if (!isHttpHandler) continue;

        const fnLine = content.slice(0, fMatch.index).split("\n").length;
        const bodyStart = fMatch.index + fMatch[0].length;
        const bodyEnd = this.findGoBraceBlockEnd(content, bodyStart - 1);
        const fnBody = content.slice(bodyStart, bodyEnd);

        // Detect DTO binding: ShouldBindJSON(&req), c.Bind(&req), Decode(&req), c.BodyParser(&req)
        let boundDto: string | undefined;
        const bindMatch = fnBody.match(/(?:ShouldBind(?:JSON|Query|URI|XML|YAML|Header)?|Bind(?:JSON)?|Decode|(?:Body|Params|Query)Parser)\s*\(\s*&([a-zA-Z0-9_]+)\s*\)/);
        if (bindMatch) {
          const varName = bindMatch[1];
          // Look for explicit type declaration:
          // var req CreateOrderRequest
          // var req models.CreateOrderRequest
          // req := CreateOrderRequest{}
          // req := &CreateOrderRequest{}
          // req := new(CreateOrderRequest)
          const typeRegex = new RegExp(
            `(?:var\\s+${varName}\\s+(?:[a-zA-Z0-9_]+\\.)?([A-Z][a-zA-Z0-9_]+)|` +
            `${varName}\\s*:=\\s*&?(?:[a-zA-Z0-9_]+\\.)?([A-Z][a-zA-Z0-9_]+)\\s*\\{|` +
            `${varName}\\s*:=\\s*new\\s*\\((?:[a-zA-Z0-9_]+\\.)?([A-Z][a-zA-Z0-9_]+)\\))`
          );
          const typeMatch = fnBody.match(typeRegex);
          if (typeMatch) {
            boundDto = typeMatch[1] || typeMatch[2] || typeMatch[3];
          }
          // Note: If no type matched, do NOT synthesize a fake name (strict evidence invariant)
        }

        // Detect service calls: h.orderService.Process(...) or s.service.Create(...)
        let serviceCall: string | undefined;
        const sMatch = fnBody.match(/([a-zA-Z0-9_]+(?:Service|Usecase|UC))\s*\.\s*([A-Z][a-zA-Z0-9_]+)/i);
        if (sMatch) {
          serviceCall = `${sMatch[1]}::${sMatch[2]}`;
        }

        // Detect repo/db calls: h.repo.Save(...) or db.Create(&order)
        let repoCall: string | undefined;
        const rMatch = fnBody.match(/(?:([a-zA-Z0-9_]+(?:Repo|Repository))\s*\.\s*([A-Z][a-zA-Z0-9_]+)|db\s*\.\s*(?:Create|Save|Find|First|Update|Delete)\s*\(\s*&?([A-Z][a-zA-Z0-9_]+)\s*\))/i);
        if (rMatch) {
          repoCall = rMatch[1] ? `${rMatch[1]}::${rMatch[2]}` : `DB::${rMatch[3]}`;
        }

        const info: HandlerInfo = {
          name: fnName,
          receiver,
          file,
          relPath,
          line: fnLine,
          boundDto,
          serviceCall,
          repoCall,
        };

        if (receiver) {
          handlers.set(`${receiver}.${fnName}`, info);
        } else {
          handlers.set(fnName, info);
        }
      }

      // Catalog struct definitions
      const structRegex = /type\s+([A-Z][a-zA-Z0-9_]+)\s+(?:struct|interface)\s*\{/g;
      let sDeclMatch: RegExpExecArray | null;
      while ((sDeclMatch = structRegex.exec(content)) !== null) {
        const sName = sDeclMatch[1];
        const sLine = content.slice(0, sDeclMatch.index).split("\n").length;
        const sBodyStart = sDeclMatch.index + sDeclMatch[0].length;
        const sBodyEnd = this.findGoBraceBlockEnd(content, sBodyStart - 1);
        const sBody = content.slice(sBodyStart, sBodyEnd);

        const fields = new Map<string, string>();
        const fieldRegex = /^\s*([a-zA-Z0-9_]+)\s+\*?(?:[a-zA-Z0-9_]+\.)?([A-Z][a-zA-Z0-9_]+)/gm;
        let fldMatch: RegExpExecArray | null;
        while ((fldMatch = fieldRegex.exec(sBody)) !== null) {
          fields.set(fldMatch[1], fldMatch[2]);
        }

        goStructs.set(sName, { name: sName, file, relPath, line: sLine, fields });
      }

      // Catalog all methods & functions for call resolution
      const allFuncRegex =
        /func\s*(?:\(\s*[a-zA-Z0-9_]+\s+\*?(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]+)\s*\)\s*)?([A-Z][a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)(?:[^{]*)\{/g;
      let afMatch: RegExpExecArray | null;
      while ((afMatch = allFuncRegex.exec(content)) !== null) {
        const rcv = afMatch[1];
        const fn = afMatch[2];
        const fLine = content.slice(0, afMatch.index).split("\n").length;
        const bStart = afMatch.index + afMatch[0].length;
        const bEnd = this.findGoBraceBlockEnd(content, bStart - 1);
        const bText = content.slice(bStart, bEnd);
        const params = afMatch[3];
        if (rcv) {
          goMethods.set(`${rcv}.${fn}`, { receiver: rcv, name: fn, file, relPath, line: fLine, body: bText, params });
        } else {
          goMethods.set(fn, { name: fn, file, relPath, line: fLine, body: bText, params });
        }
      }
    }

    // 2. Extract route registrations per file with lexical block scoping
    for (const file of goFiles) {
      const content = readOptionalSourceFile(file, "utf-8");
      if (!content) continue;

      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");

      // Find router/setup functions and methods to scope groups and variable types
      const setupFuncRegex =
        /func\s*(?:\(\s*([a-zA-Z0-9_]+)\s+\*?(?:[a-zA-Z0-9_]+\.)?([A-Z][a-zA-Z0-9_]+)\s*\)\s*)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)(?:[^{]*)\{/g;
      let funcMatch: RegExpExecArray | null;

      while ((funcMatch = setupFuncRegex.exec(content)) !== null) {
        const receiverVar = funcMatch[1];
        const receiverType = funcMatch[2];
        const funcParams = funcMatch[4];
        const funcStart = funcMatch.index;
        const bodyStart = funcStart + funcMatch[0].length;
        const bodyEnd = this.findGoBraceBlockEnd(content, bodyStart - 1);
        const funcBody = content.slice(bodyStart, bodyEnd);
        const funcOffset = content.slice(0, bodyStart).split("\n").length - 1;

        // Scoped variable -> receiver type mapping (e.g. h -> OrderHandler, s -> Server)
        const scopedVarReceivers = new Map<string, string>();
        if (receiverVar && receiverType) {
          scopedVarReceivers.set(receiverVar, receiverType);
        }

        // Map parameter variables: (h *http.OrderHandler, u *UserHandler)
        const paramRegex = /([a-zA-Z0-9_]+)\s+\*?(?:[a-zA-Z0-9_]+\.)?([A-Z][a-zA-Z0-9_]+)/g;
        let pMatch: RegExpExecArray | null;
        while ((pMatch = paramRegex.exec(funcParams)) !== null) {
          scopedVarReceivers.set(pMatch[1], pMatch[2]);
        }

        // Map local variable instantiations: h := &OrderHandler{} or var h OrderHandler
        const localInstRegex = /(?:([a-zA-Z0-9_]+)\s*:=\s*(?:&|new\s*\()?(?:[a-zA-Z0-9_]+\.)?([A-Z][a-zA-Z0-9_]+)|var\s+([a-zA-Z0-9_]+)\s+(?:[a-zA-Z0-9_]+\.)?([A-Z][a-zA-Z0-9_]+))/g;
        let lMatch: RegExpExecArray | null;
        while ((lMatch = localInstRegex.exec(funcBody)) !== null) {
          const varName = lMatch[1] || lMatch[3];
          const typeName = lMatch[2] || lMatch[4];
          if (varName && typeName) {
            scopedVarReceivers.set(varName, typeName);
          }
        }

        // Scoped router groups: groupVar -> accumulatedPrefix
        const scopedGroupPrefixes = new Map<string, string>();

        // Gin / Echo groups: v1 := r.Group("/api/v1")
        const groupRegex = /([a-zA-Z0-9_]+)\s*:=\s*([a-zA-Z0-9_]+)\.Group\s*\(\s*["']([^"']*)["']/g;
        let gMatch: RegExpExecArray | null;
        while ((gMatch = groupRegex.exec(funcBody)) !== null) {
          const newGroup = gMatch[1];
          const parentGroup = gMatch[2];
          const subPrefix = gMatch[3].replace(/\/+$/, "");

          const parentPrefix = scopedGroupPrefixes.get(parentGroup) || "";
          const cleanSub = subPrefix.startsWith("/") ? subPrefix : `/${subPrefix}`;
          scopedGroupPrefixes.set(newGroup, `${parentPrefix}${cleanSub}`);
        }

        // Chi subrouter Route: r.Route("/articles", func(r chi.Router) { ... })
        const chiRouteRegex = /([a-zA-Z0-9_]+)\.Route\s*\(\s*["']([^"']*)["']\s*,\s*func\s*\(\s*([a-zA-Z0-9_]+)\s+chi\.Router\s*\)/g;
        let cMatch: RegExpExecArray | null;
        while ((cMatch = chiRouteRegex.exec(funcBody)) !== null) {
          const parentRouter = cMatch[1];
          const subPrefix = cMatch[2].replace(/\/+$/, "");
          const subRouter = cMatch[3];

          const parentPrefix = scopedGroupPrefixes.get(parentRouter) || "";
          const cleanSub = subPrefix.startsWith("/") ? subPrefix : `/${subPrefix}`;
          scopedGroupPrefixes.set(subRouter, `${parentPrefix}${cleanSub}`);
        }

        // 3. Extract route registrations within this function scope
        // Method 1: Gin / Echo / Chi HTTP method calls: r.GET("/ping", pingHandler), v1.POST("/orders", h.CreateOrder)
        const routeRegex =
          /([a-zA-Z0-9_]+)\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*["']([^"']*)["']\s*,\s*(?:[a-zA-Z0-9_.]+\s*,\s*)*(?:func\s*\([^)]*\)|([a-zA-Z0-9_.]+))/g;
        let rMatch: RegExpExecArray | null;

        while ((rMatch = routeRegex.exec(funcBody)) !== null) {
          const routerVar = rMatch[1];
          const httpMethod = rMatch[2].toUpperCase();
          const rawUri = rMatch[3];
          const handlerTarget = (rMatch[4] && rMatch[4] !== "func") ? rMatch[4] : "closure";
          const routeLine = funcOffset + funcBody.slice(0, rMatch.index).split("\n").length;

          const groupPrefix = scopedGroupPrefixes.get(routerVar) || "";
          const cleanSub = rawUri ? (rawUri.startsWith("/") ? rawUri : `/${rawUri}`) : "";
          const fullUri = `${groupPrefix}${cleanSub}` || "/";

          this.pushSlice(
            slices,
            projectRoot,
            relPath,
            routeLine,
            httpMethod,
            fullUri,
            handlerTarget,
            handlers,
            scopedVarReceivers,
            goStructs,
            goMethods,
            domainId
          );
        }

        // Method 2: Standard net/http HandleFunc and Handle:
        // http.HandleFunc("/ping", pingHandler)
        // mux.HandleFunc("GET /users", h.GetUsers)
        // mux.HandleFunc("POST /users", h.CreateUser)
        // mux.Handle("/orders", h)
        const netHttpRegex =
          /(?:([a-zA-Z0-9_]+|http)\.)?(?:HandleFunc|Handle)\s*\(\s*["']([^"']*)["']\s*,\s*(?:func\s*\([^)]*\)|([a-zA-Z0-9_.]+))/g;
        let nhMatch: RegExpExecArray | null;

        while ((nhMatch = netHttpRegex.exec(funcBody)) !== null) {
          const pattern = nhMatch[2].trim();
          const handlerTarget = (nhMatch[3] && nhMatch[3] !== "func") ? nhMatch[3] : "closure";
          const routeLine = funcOffset + funcBody.slice(0, nhMatch.index).split("\n").length;

          // Parse Go 1.22+ pattern with optional method: "GET /path" or just "/path"
          const patternMatch = pattern.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(.*)$/);
          let httpMethod = "ANY";
          let rawUri = pattern;

          if (patternMatch) {
            httpMethod = patternMatch[1];
            rawUri = patternMatch[2].trim();
          }

          const cleanUri = rawUri.startsWith("/") ? rawUri : `/${rawUri}`;

          this.pushSlice(
            slices,
            projectRoot,
            relPath,
            routeLine,
            httpMethod,
            cleanUri,
            handlerTarget,
            handlers,
            scopedVarReceivers,
            goStructs,
            goMethods,
            domainId
          );
        }
      }
    }

    return slices;
  }

  private pushSlice(
    slices: VerticalSliceCandidate[],
    projectRoot: string,
    relPath: string,
    routeLine: number,
    httpMethod: string,
    fullUri: string,
    handlerTarget: string,
    handlers: Map<string, any>,
    scopedVarReceivers: Map<string, string>,
    goStructs: Map<string, any>,
    goMethods: Map<string, any>,
    domainId?: number
  ): void {
    let handlerInfo: any = undefined;
    let controllerClass = path.basename(relPath, ".go");
    let actionName = handlerTarget;

    if (handlerTarget.includes(".")) {
      const parts = handlerTarget.split(".");
      const varName = parts[0];
      const memberName = parts[1];
      actionName = memberName;

      // Look up variable receiver type
      const receiverType = scopedVarReceivers.get(varName);
      if (receiverType) {
        controllerClass = receiverType;
        handlerInfo = handlers.get(`${receiverType}.${memberName}`);
      } else {
        handlerInfo = handlers.get(handlerTarget);
        if (handlerInfo?.receiver) {
          controllerClass = handlerInfo.receiver;
        }
      }
    } else {
      handlerInfo = handlers.get(handlerTarget);
      if (handlerInfo?.receiver) {
        controllerClass = handlerInfo.receiver;
      }
    }

    const controllerFile = handlerInfo?.relPath || relPath;
    const controllerLine = handlerInfo?.line || routeLine;

    const chain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
      {
        stage: "ingress",
        symbol: `${httpMethod} ${fullUri}`,
        file: relPath,
        line: routeLine,
        description: `Go Route: ${httpMethod} ${fullUri}`,
      },
    ];

    if (handlerInfo?.boundDto) {
      chain.push({
        stage: "validation",
        symbol: handlerInfo.boundDto,
        description: `Request DTO Binding: ${handlerInfo.boundDto}`,
      });
    }

    chain.push({
      stage: "controller",
      symbol: `${controllerClass}::${actionName}`,
      file: controllerFile,
      line: controllerLine,
      description: `Go Route Handler: ${actionName}`,
    });

    let serviceFile: string | undefined;
    let serviceLine: number | undefined;
    let repoCall = handlerInfo?.repoCall;
    let repoFile: string | undefined;
    let repoLine: number | undefined;
    let entityName: string | undefined;
    let entityFile: string | undefined;
    let entityLine: number | undefined;

    let targetMethod: any = undefined;
    let targetStruct: any = undefined;

    if (handlerInfo?.serviceCall) {
      const parts = handlerInfo.serviceCall.split("::");
      const callVar = parts[0];
      const callMethod = parts[1];

      const handlerStruct = goStructs.get(controllerClass);
      const svcType = handlerStruct?.fields.get(callVar) || callVar;
      targetMethod = goMethods.get(`${svcType}.${callMethod}`) || goMethods.get(`${callVar}.${callMethod}`);
      targetStruct = goStructs.get(svcType);

      serviceFile = targetMethod?.relPath || targetStruct?.relPath;
      serviceLine = targetMethod?.line || targetStruct?.line;

      // Scan service body for repo or DB persistence
      if (targetMethod?.body) {
        const rMatch = targetMethod.body.match(
          /(?:(?:[a-zA-Z0-9_]+\.)?([a-zA-Z0-9_]*(?:repo|repository))\s*\.\s*([A-Z][a-zA-Z0-9_]+)|db\s*\.\s*(?:Create|Save|Find|First|Update|Delete)\s*\(\s*&?([A-Z][a-zA-Z0-9_]+)\s*\))/i
        );
        if (rMatch && !repoCall) {
          repoCall = rMatch[1] ? `${rMatch[1]}::${rMatch[2]}` : `DB::${rMatch[3]}`;
        }
      }
    }

    if (repoCall) {
      const rParts = repoCall.split("::");
      const rVar = rParts[0];
      const rMethod = rParts[1];

      let rType = rVar;
      const handlerStruct = goStructs.get(controllerClass);
      if (handlerStruct?.fields?.has(rVar)) {
        rType = handlerStruct.fields.get(rVar)!;
      } else if (targetStruct?.fields?.has(rVar)) {
        rType = targetStruct.fields.get(rVar)!;
      }
      rType = rType.replace(/^\*?(?:[a-zA-Z0-9_]+\.)?/, "");

      const rMethodInfo = goMethods.get(`${rType}.${rMethod}`) || goMethods.get(`${rVar}.${rMethod}`);
      const rStructInfo = goStructs.get(rType);
      repoFile = rMethodInfo?.relPath || rStructInfo?.relPath;
      repoLine = rMethodInfo?.line || rStructInfo?.line;

      if (rVar === "DB" && rMethod) {
        entityName = rMethod;
      } else if (rMethodInfo?.body) {
        const entMatch = rMethodInfo.body.match(/&?([A-Z][a-zA-Z0-9_]+)\s*\{/);
        if (entMatch) entityName = entMatch[1];
      }
      if (!entityName && rMethodInfo?.params) {
        const pMatch = rMethodInfo.params.match(/\*?(?:[a-zA-Z0-9_]+\.)?([A-Z][a-zA-Z0-9_]+)\b/);
        if (pMatch && goStructs.has(pMatch[1])) entityName = pMatch[1];
      }
      if (!entityName && targetMethod?.params) {
        const pMatch = targetMethod.params.match(/\*?(?:[a-zA-Z0-9_]+\.)?([A-Z][a-zA-Z0-9_]+)\b/);
        if (pMatch && goStructs.has(pMatch[1])) entityName = pMatch[1];
      }
    }

    if (!entityName && handlerInfo?.boundDto) {
      const candidate = handlerInfo.boundDto.replace(/(?:Request|Req|DTO|Dto)$/, "");
      if (candidate && goStructs.has(candidate)) {
        entityName = candidate;
      }
    }

    if (entityName && goStructs.has(entityName)) {
      const entInfo = goStructs.get(entityName)!;
      entityFile = entInfo.relPath;
      entityLine = entInfo.line;
    }

    if (handlerInfo?.serviceCall) {
      chain.push({
        stage: "service",
        symbol: handlerInfo.serviceCall,
        ...(serviceFile ? { file: serviceFile, line: serviceLine } : {}),
        description: serviceFile ? "Go Service / Business Logic" : `Service / Business Logic`,
      });
    }

    if (repoCall) {
      chain.push({
        stage: "repository",
        symbol: repoCall,
        ...(repoFile ? { file: repoFile, line: repoLine } : {}),
        description: repoFile ? "Go Repository / Persistence Layer" : `Persistence / Database Operation`,
      });
    }

    if (entityName) {
      chain.push({
        stage: "entity",
        symbol: entityName,
        ...(entityFile ? { file: entityFile, line: entityLine } : {}),
        description: entityFile ? "Go Database / Domain Entity" : `Domain Entity`,
      });
    }

    slices.push({
      domain_id: domainId ?? null,
      feature_key: null,
      http_method: httpMethod,
      route_uri: fullUri,
      route_name: `${controllerClass}.${actionName}`,
      controller_class: controllerClass,
      action_name: actionName,
      controller_file: controllerFile,
      controller_line: controllerLine,
      architecture_style: "go-http",
      entry_kind: "http_route",
      execution_chain_json: JSON.stringify(chain),
    });
  }

  private findGoBraceBlockEnd(content: string, startIndex: number): number {
    let depth = 0;
    let started = false;

    for (let i = startIndex; i < content.length; i++) {
      const char = content[i];
      if (char === "{") {
        depth++;
        started = true;
      } else if (char === "}") {
        depth--;
        if (started && depth === 0) {
          return i;
        }
      }
    }

    return content.length;
  }

  private findGoFiles(dir: string, maxDepth: number = 10): string[] {
    const results: string[] = [];
    const traverse = (currentDir: string, currentDepth: number) => {
      if (currentDepth > maxDepth || !fs.existsSync(currentDir)) return;
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (isIgnoredDirectory(entry.name)) continue;

          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            traverse(fullPath, currentDepth + 1);
          } else if (entry.isFile() && entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) {
            results.push(fullPath);
          }
        }
      } catch {}
    };

    traverse(dir, 0);
    return results;
  }
}
