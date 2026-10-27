import type { ArchetypeKind, ParsedFileAST } from "../../../types/index.ts";

export interface CodeExtractor {
  canHandle(filePath: string): boolean;
  extract(filePath: string, content: string): Promise<ParsedFileAST>;
}

export function detectArchetype(filePath: string, archetypesMap: Record<string, string>): ArchetypeKind {
  const normalized = filePath.replace(/\\/g, "/");

  // Check user-configured archetype glob patterns
  for (const [archetype, pattern] of Object.entries(archetypesMap)) {
    if (matchesSimpleGlob(normalized, pattern)) {
      return archetype as ArchetypeKind;
    }
  }

  // Built-in convention heuristics
  const lower = normalized.toLowerCase();
  if (lower.includes("controller")) return "controller";
  if (lower.endsWith("views.py") || (lower.includes("views/") && lower.endsWith(".py"))) return "controller";
  if (lower.includes("service")) return "service";
  if (lower.includes("repository") || lower.includes("repo")) return "repository";
  if (lower.includes("model") || lower.includes("entities") || lower.includes("entity")) return "model";
  if (lower.includes("action")) return "action";
  if (lower.includes("job") || lower.includes("queue")) return "job";
  if (lower.includes("event")) return "event";
  if (lower.includes("listener")) return "listener";
  if (lower.includes("middleware")) return "middleware";
  if (lower.includes("request") || lower.includes("serializer") || lower.includes("schema")) return "request";
  if (lower.includes("resource")) return "resource";
  if (lower.includes(".blade.php") || lower.includes("views/") || lower.includes("templates/")) return "view";
  if (lower.includes("route") || lower.includes("router")) return "route";
  if (lower.includes("util") || lower.includes("helper")) return "util";

  return "unknown";
}

export function matchesSimpleGlob(path: string, pattern: string, allowBasename: boolean = true): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");

  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped
    .replace(/\*\*\//g, "\0GLOB_GLOB_SLASH\0")
    .replace(/\*\*/g, "\0GLOB_GLOB\0")
    .replace(/\*/g, "\0GLOB_STAR\0")
    .replace(/\?/g, "\0GLOB_Q\0")
    .replace(/\0GLOB_GLOB_SLASH\0/g, "(?:.*\\/)?")
    .replace(/\0GLOB_GLOB\0/g, ".*")
    .replace(/\0GLOB_STAR\0/g, "[^/]*")
    .replace(/\0GLOB_Q\0/g, "[^/]");

  const regex = new RegExp(`^${regexStr}$`, "i");
  if (regex.test(normalizedPath)) {
    return true;
  }

  // If pattern does not contain directory separators, allow matching against the basename
  if (allowBasename && !normalizedPattern.includes("/")) {
    const base = normalizedPath.split("/").pop() ?? "";
    return regex.test(base);
  }

  return false;
}

