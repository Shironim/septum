import { readOptionalSourceFile } from "../../resources/source-files.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SemanticSliceExtractor, VerticalSliceCandidate } from "./semantic-extractor.interface.ts";

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
        if (deps["@nestjs/core"]) return true;
      } catch {}
    }

    return false;
  }

  public extractSlices(projectRoot: string, domainId?: number): VerticalSliceCandidate[] {
    const slices: VerticalSliceCandidate[] = [];
    const srcDir = path.join(projectRoot, "src");
    if (!fs.existsSync(srcDir)) return slices;

    const controllerFiles = this.findFilesRecursively(srcDir, /\.controller\.(ts|js)$/);

    for (const file of controllerFiles) {
      const relPath = path.relative(projectRoot, file).replace(/\\/g, "/");
      const content = readOptionalSourceFile(file, "utf-8");

      // Extract @Controller('prefix')
      const controllerMatch = /@Controller\s*\(\s*['"]?([^'")]*)['"]?\s*\)[\s\S]*?export\s+class\s+([A-Za-z0-9_]+)/.exec(
        content
      );
      if (!controllerMatch) continue;

      const routePrefix = controllerMatch[1] ? `/${controllerMatch[1].replace(/^\/+|\/+$/g, "")}` : "";
      const controllerClass = controllerMatch[2];
      const controllerClassLine =
        controllerMatch.index !== undefined
          ? content
              .slice(0, controllerMatch.index + controllerMatch[0].lastIndexOf(controllerClass))
              .split("\n").length
          : 1;

      // Extract methods: @Get('path'), @Post('path'), etc.
      const methodRegex =
        /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"]?([^'")]*)['"]?\s*\)\s*(?:@[A-Za-z0-9_]+\s*\([^)]*\)\s*)*\s*(?:(?:public|protected|private)\s+)?(?:async\s+)?([a-zA-Z0-9_]+)\s*\(([^)]*)\)/g;
      let match: RegExpExecArray | null;

      while ((match = methodRegex.exec(content)) !== null) {
        const httpMethod = match[1].toUpperCase();
        const subPath = match[2] ? `/${match[2].replace(/^\/+|\/+$/g, "")}` : "";
        const fullUri = `${routePrefix}${subPath}` || "/";
        const actionName = match[3];
        const params = match[4];

        const decoratorLine = content.slice(0, match.index).split("\n").length;
        const actionOffset = match.index + match[0].lastIndexOf(actionName);
        const actionLine = content.slice(0, actionOffset).split("\n").length || controllerClassLine;

        // Extract DTO from parameters: e.g. @Body() createDto: CreateUserDto
        const dtoMatch = params.match(/@Body\s*\([^)]*\)\s*[a-zA-Z0-9_]+\s*:\s*([A-Za-z0-9_]+Dto)/);
        const formRequestClass = dtoMatch ? dtoMatch[1] : null;

        const chain: Array<{ stage: string; symbol: string; file?: string; line?: number; description?: string }> = [
          {
            stage: "ingress",
            symbol: `${httpMethod} ${fullUri}`,
            file: relPath,
            line: decoratorLine,
            description: `NestJS Route: ${httpMethod} ${fullUri}`,
          },
        ];

        if (formRequestClass) {
          chain.push({
            stage: "validation",
            symbol: formRequestClass,
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


    return slices;
  }

  private findFilesRecursively(dir: string, pattern: RegExp): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          results.push(...this.findFilesRecursively(full, pattern));
        } else if (entry.isFile() && pattern.test(entry.name)) {
          results.push(full);
        }
      }
    } catch {}
    return results;
  }
}
