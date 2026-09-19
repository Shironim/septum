import * as fs from "node:fs";
import * as path from "node:path";
import type { VerticalSliceRecord } from "../../../types/index.ts";
import type {
  SemanticSliceExtractor,
  VerticalSliceCandidate,
} from "./semantic-extractor.interface.ts";

export interface ParsedRoute {
  httpMethod: string;
  uri: string;
  routeName?: string;
  controllerClass: string;
  actionName: string;
}

export type LaravelSemanticExtractionResult = VerticalSliceCandidate[] & {
  slices: VerticalSliceCandidate[];
};

export class LaravelSemanticExtractor implements SemanticSliceExtractor {
  public readonly id = "laravel";
  public readonly name = "Laravel MVC Semantic Extractor";

  constructor(private projectRoot: string = process.cwd()) {}

  public canHandle(projectRoot: string, framework?: string): boolean {
    if (framework === "laravel") return true;
    return (
      fs.existsSync(path.join(projectRoot, "artisan")) ||
      fs.existsSync(path.join(projectRoot, "routes/web.php")) ||
      fs.existsSync(path.join(projectRoot, "routes/api.php"))
    );
  }

  /**
   * Scan route files and extract complete vertical slices.
   */
  public extractSlices(
    projectRootOrDomainId?: string | number,
    maybeDomainId?: number
  ): LaravelSemanticExtractionResult {
    let root = this.projectRoot;
    let domainId: number | undefined;

    if (typeof projectRootOrDomainId === "string") {
      root = projectRootOrDomainId;
      domainId = maybeDomainId;
    } else if (typeof projectRootOrDomainId === "number") {
      domainId = projectRootOrDomainId;
    }

    const routeFiles = [
      path.join(root, "routes/web.php"),
      path.join(root, "routes/api.php"),
    ].filter((f) => fs.existsSync(f));

    const parsedRoutes: ParsedRoute[] = [];

    for (const routeFile of routeFiles) {
      const content = fs.readFileSync(routeFile, "utf-8");
      parsedRoutes.push(...this.parseRoutesContent(content));
    }

    const slices: Array<Omit<VerticalSliceRecord, "id" | "created_at">> = [];

    for (const route of parsedRoutes) {
      const controllerInfo = this.resolveController(route.controllerClass, route.actionName);

      let formRequestInfo: {
        className: string;
        filePath?: string;
        rules: Record<string, string>;
      } | null = null;

      let modelInfo: {
        className: string;
        filePath?: string;
        fillable: string[];
        casts: Record<string, string>;
      } | null = null;

      let frontendInfo: {
        target: string;
        props: string[];
      } | null = null;

      if (controllerInfo.filePath && fs.existsSync(controllerInfo.filePath)) {
        const controllerCode = fs.readFileSync(controllerInfo.filePath, "utf-8");
        const actionBody = this.extractActionBody(controllerCode, route.actionName);

        // 1. Detect FormRequest in method signature
        const requestClassName = this.detectFormRequestClass(controllerCode, route.actionName);
        if (requestClassName) {
          const reqFile = this.findClassFile("Requests", requestClassName);
          const rules = reqFile && fs.existsSync(reqFile) ? this.extractValidationRules(fs.readFileSync(reqFile, "utf-8")) : {};
          formRequestInfo = {
            className: requestClassName,
            filePath: reqFile ? path.relative(this.projectRoot, reqFile) : undefined,
            rules,
          };
        }

        // 2. Detect Model referenced in parameters or action body
        const modelClassName = this.detectModelClass(controllerCode, route.actionName, actionBody);
        if (modelClassName) {
          const modFile = this.findClassFile("Models", modelClassName);
          const modMetadata = modFile && fs.existsSync(modFile) ? this.extractModelMetadata(fs.readFileSync(modFile, "utf-8")) : { fillable: [], casts: {} };
          modelInfo = {
            className: modelClassName,
            filePath: modFile ? path.relative(this.projectRoot, modFile) : undefined,
            fillable: modMetadata.fillable,
            casts: modMetadata.casts,
          };
        }

        // 3. Detect Inertia Render / View Target
        frontendInfo = this.detectFrontendTarget(actionBody);
      }

      const chain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
        {
          stage: "ingress",
          symbol: `${route.httpMethod.toUpperCase()} ${route.uri.startsWith("/") ? route.uri : `/${route.uri}`}`,
          file: route.file,
          description: `HTTP Route: ${route.routeName || route.uri}`,
        },
      ];

      if (formRequestInfo) {
        chain.push({
          stage: "validation",
          symbol: formRequestInfo.className,
          file: formRequestInfo.filePath,
          description: "Form Request Validation",
        });
      }

      chain.push({
        stage: "controller",
        symbol: `${route.controllerClass}::${route.actionName}`,
        file: controllerInfo.filePath ? path.relative(this.projectRoot, controllerInfo.filePath) : undefined,
        line: controllerInfo.line,
        description: `Controller Action`,
      });

      if (modelInfo) {
        chain.push({
          stage: "entity",
          symbol: modelInfo.className,
          file: modelInfo.filePath,
          description: "Eloquent Model",
        });
      }

      if (frontendInfo) {
        chain.push({
          stage: "egress",
          symbol: frontendInfo.target,
          description: "Inertia / Frontend Target",
        });
      }

      slices.push({
        domain_id: domainId ?? null,
        feature_key: route.routeName || null,
        http_method: route.httpMethod.toUpperCase(),
        route_uri: route.uri.startsWith("/") ? route.uri : `/${route.uri}`,
        route_name: route.routeName || null,
        controller_class: route.controllerClass,
        action_name: route.actionName,
        controller_file: controllerInfo.filePath ? path.relative(this.projectRoot, controllerInfo.filePath) : null,
        controller_line: controllerInfo.line,
        architecture_style: "mvc",
        entry_kind: "http_route",
        execution_chain_json: JSON.stringify(chain),
      });
    }

    return Object.assign(slices, { slices });
  }

  /**
   * Parse Laravel Route declarations.
   */
  public parseRoutesContent(content: string): ParsedRoute[] {
    const routes: ParsedRoute[] = [];

    // Match Route::(get|post|put|patch|delete)('uri', [Controller::class, 'action'])->name('...')
    const methodRegex = /Route::(get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*(?:\[\s*([A-Za-z0-9_]+)::class\s*,\s*['"]([A-Za-z0-9_]+)['"]\s*\]|['"]([A-Za-z0-9_]+)@([A-Za-z0-9_]+)['"])\s*\)(?:\s*->\s*name\s*\(\s*['"]([^'"]+)['"]\s*\))?/gi;

    let match;
    while ((match = methodRegex.exec(content)) !== null) {
      const httpMethod = match[1];
      const uri = match[2];
      const controllerClass = match[3] || match[5];
      const actionName = match[4] || match[6];
      const routeName = match[7];

      if (controllerClass && actionName) {
        routes.push({
          httpMethod,
          uri,
          routeName,
          controllerClass,
          actionName,
        });
      }
    }

    // Match Route::resource('orders', OrderController::class)
    const resourceRegex = /Route::resource\s*\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z0-9_]+)::class\s*\)/gi;
    while ((match = resourceRegex.exec(content)) !== null) {
      const baseUri = match[1];
      const controllerClass = match[2];
      const resourceActions = [
        { method: "GET", sub: "", action: "index" },
        { method: "GET", sub: "/create", action: "create" },
        { method: "POST", sub: "", action: "store" },
        { method: "GET", sub: "/{id}", action: "show" },
        { method: "GET", sub: "/{id}/edit", action: "edit" },
        { method: "PUT", sub: "/{id}", action: "update" },
        { method: "DELETE", sub: "/{id}", action: "destroy" },
      ];

      for (const res of resourceActions) {
        routes.push({
          httpMethod: res.method,
          uri: `/${baseUri}${res.sub}`,
          routeName: `${baseUri}.${res.action}`,
          controllerClass,
          actionName: res.action,
        });
      }
    }

    return routes;
  }

  private resolveController(controllerClass: string, actionName: string): { filePath?: string; line: number } {
    const simpleName = controllerClass.split(/\\|\//).pop() || controllerClass;
    const candidates = [
      path.join(this.projectRoot, `app/Http/Controllers/${simpleName}.php`),
      path.join(this.projectRoot, `app/Http/Controllers/Api/${simpleName}.php`),
      path.join(this.projectRoot, `app/Http/Controllers/Admin/${simpleName}.php`),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const lines = fs.readFileSync(c, "utf-8").split("\n");
        let targetLine = 1;
        for (let i = 0; i < lines.length; i++) {
          if (new RegExp(`function\\s+${actionName}\\s*\\(`, "i").test(lines[i])) {
            targetLine = i + 1;
            break;
          }
        }
        return { filePath: c, line: targetLine };
      }
    }

    return { line: 0 };
  }

  private extractActionBody(controllerCode: string, actionName: string): string {
    const fnRegex = new RegExp(`public\\s+function\\s+${actionName}\\s*\\([^{]*\\)\\s*\\{`, "i");
    const match = fnRegex.exec(controllerCode);
    if (!match) return "";

    const startIndex = match.index + match[0].length;
    let braceDepth = 1;
    let endIndex = startIndex;

    while (braceDepth > 0 && endIndex < controllerCode.length) {
      const char = controllerCode[endIndex];
      if (char === "{") braceDepth++;
      else if (char === "}") braceDepth--;
      endIndex++;
    }

    return controllerCode.substring(startIndex, endIndex - 1);
  }

  private detectFormRequestClass(controllerCode: string, actionName: string): string | null {
    const paramRegex = new RegExp(`public\\s+function\\s+${actionName}\\s*\\(([^)]*)\\)`, "i");
    const match = paramRegex.exec(controllerCode);
    if (!match) return null;

    const params = match[1];
    // Find class names ending with Request
    const reqMatch = params.match(/([A-Za-z0-9_]+Request)\s+\$/);
    if (reqMatch && reqMatch[1] !== "Request") {
      return reqMatch[1];
    }
    return null;
  }

  private detectModelClass(controllerCode: string, actionName: string, actionBody: string): string | null {
    // 1. Method signature type-hints: (Order $order)
    const paramRegex = new RegExp(`public\\s+function\\s+${actionName}\\s*\\(([^)]*)\\)`, "i");
    const match = paramRegex.exec(controllerCode);
    if (match) {
      const parts = match[1].split(",");
      for (const p of parts) {
        const pMatch = p.trim().match(/^([A-Z][A-Za-z0-9_]+)\s+\$/);
        if (pMatch && !pMatch[1].endsWith("Request") && pMatch[1] !== "Request") {
          return pMatch[1];
        }
      }
    }

    // 2. Action body static calls: Order::find(), Order::create(), Order::query()
    const staticModelMatch = actionBody.match(/([A-Z][A-Za-z0-9_]+)::(?:find|findOrFail|create|where|query)\s*\(/);
    if (staticModelMatch && !["Inertia", "Route", "DB", "Auth", "Log", "Response"].includes(staticModelMatch[1])) {
      return staticModelMatch[1];
    }

    return null;
  }

  private detectFrontendTarget(actionBody: string): { target: string; props: string[] } | null {
    // 1. Inertia::render('Orders/Show', ['order' => $order])
    const inertiaMatch = actionBody.match(/Inertia::render\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*\[([^\]]*)\])?\s*\)/);
    if (inertiaMatch) {
      const pageComponent = inertiaMatch[1]; // e.g. "Orders/Show"
      const rawProps = inertiaMatch[2] || "";

      // Extract prop keys: 'order' => ...
      const propMatches = rawProps.matchAll(/['"]([A-Za-z0-9_]+)['"]\s*=>/g);
      const props: string[] = [];
      for (const pm of propMatches) {
        props.push(pm[1]);
      }

      // Check for Vue, TSX, JSX files in resources/js/Pages
      const possibleExtensions = [".vue", ".tsx", ".jsx", ".svelte"];
      let frontendPath = `resources/js/Pages/${pageComponent}`;
      for (const ext of possibleExtensions) {
        const fullCandidate = path.join(this.projectRoot, `resources/js/Pages/${pageComponent}${ext}`);
        if (fs.existsSync(fullCandidate)) {
          frontendPath = `resources/js/Pages/${pageComponent}${ext}`;
          break;
        }
      }
      if (!frontendPath.includes(".")) {
        frontendPath += ".vue"; // Default inertia convention
      }

      return {
        target: frontendPath,
        props,
      };
    }

    // 2. view('orders.show', compact('order'))
    const viewMatch = actionBody.match(/view\s*\(\s*['"]([^'"]+)['"]/);
    if (viewMatch) {
      const viewPath = viewMatch[1].replace(/\./g, "/");
      return {
        target: `resources/views/${viewPath}.blade.php`,
        props: [],
      };
    }

    return null;
  }

  private findClassFile(subDir: "Requests" | "Models", className: string): string | null {
    const directPath = path.join(this.projectRoot, `app/${subDir}/${className}.php`);
    if (fs.existsSync(directPath)) return directPath;

    // Direct app/ fallback for older Laravel
    const flatPath = path.join(this.projectRoot, `app/${className}.php`);
    if (fs.existsSync(flatPath)) return flatPath;

    return null;
  }

  private extractValidationRules(requestCode: string): Record<string, string> {
    const rules: Record<string, string> = {};
    const rulesMatch = requestCode.match(/function\s+rules\s*\(\s*\)[^{]*\{([^}]*)\}/i);
    if (!rulesMatch) return rules;

    const body = rulesMatch[1];
    // Match 'status' => 'in:pending,paid' or 'status' => ['required', 'string']
    const rulePairRegex = /['"]([A-Za-z0-9_]+)['"]\s*=>\s*(?:['"]([^'"]+)['"]|\[([^\]]+)\])/g;
    let rm;
    while ((rm = rulePairRegex.exec(body)) !== null) {
      const field = rm[1];
      const singleRule = rm[2];
      const arrayRules = rm[3];
      if (singleRule) {
        rules[field] = singleRule;
      } else if (arrayRules) {
        rules[field] = arrayRules.replace(/['"\s]/g, "").replace(/,/g, "|");
      }
    }

    return rules;
  }

  private extractModelMetadata(modelCode: string): { fillable: string[]; casts: Record<string, string> } {
    const fillable: string[] = [];
    const casts: Record<string, string> = {};

    // Match protected $fillable = [...]
    const fillableMatch = modelCode.match(/\$fillable\s*=\s*\[([^\]]*)\]/);
    if (fillableMatch) {
      const items = fillableMatch[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g);
      for (const it of items) {
        fillable.push(it[1]);
      }
    }

    // Match protected $casts = [...]
    const castsMatch = modelCode.match(/\$casts\s*=\s*\[([^\]]*)\]/);
    if (castsMatch) {
      const castItems = castsMatch[1].matchAll(/['"]([A-Za-z0-9_]+)['"]\s*=>\s*(?:['"]([^'"]+)['"]|([A-Za-z0-9_]+)::class)/g);
      for (const ci of castItems) {
        casts[ci[1]] = ci[2] || ci[3];
      }
    }

    return { fillable, casts };
  }
}
