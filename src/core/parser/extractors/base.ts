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
  if (lower.includes("service")) return "service";
  if (lower.includes("repository") || lower.includes("repo")) return "repository";
  if (lower.includes("model") || lower.includes("entities") || lower.includes("entity")) return "model";
  if (lower.includes("action")) return "action";
  if (lower.includes("job") || lower.includes("queue")) return "job";
  if (lower.includes("event")) return "event";
  if (lower.includes("listener")) return "listener";
  if (lower.includes("middleware")) return "middleware";
  if (lower.includes("request")) return "request";
  if (lower.includes("resource")) return "resource";
  if (lower.includes("util") || lower.includes("helper")) return "util";

  return "unknown";
}

function matchesSimpleGlob(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");

  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped
    .replace(/\*\*\//g, "(?:.*\\/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");

  const regex = new RegExp(`^${regexStr}$`, "i");
  if (regex.test(normalizedPath)) {
    return true;
  }

  // If pattern does not contain directory separators, allow matching against the basename
  if (!normalizedPattern.includes("/")) {
    const base = normalizedPath.split("/").pop() ?? "";
    return regex.test(base);
  }

  return false;
}

