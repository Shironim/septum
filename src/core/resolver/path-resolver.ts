import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export const PROJECT_ROOT_MARKERS = [
  "package.json",
  "composer.json",
  "go.mod",
  "pyproject.toml",
  "Cargo.toml",
  ".git",
  ".septum",
  "pnpm-workspace.yaml",
  "lerna.json",
  "tsconfig.json",
  "jsconfig.json",
];

let lastKnownProjectRoot: string | undefined;

/**
 * Normalizes and canonicalizes a path for cross-platform consistency.
 * On Windows, uppercases drive letters (e.g. "c:\" -> "C:\") to eliminate map lookup misses.
 */
export function canonicalizePath(targetPath: string): string {
  if (!targetPath || typeof targetPath !== "string") {
    return targetPath;
  }
  let abs = normalize(resolve(targetPath));
  if (process.platform === "win32") {
    abs = abs.replace(/^[a-zA-Z]:/, (m) => m.toUpperCase());
  }
  return abs;
}

export function setLastKnownProjectRoot(root: string): void {
  if (root && typeof root === "string") {
    lastKnownProjectRoot = canonicalizePath(root);
  }
}

export function getLastKnownProjectRoot(): string | undefined {
  return lastKnownProjectRoot;
}

export function clearLastKnownProjectRoot(): void {
  lastKnownProjectRoot = undefined;
}

/**
 * Checks whether a given directory is an MCP host / IDE installation directory
 * (e.g. Antigravity Electron install directory) rather than a user project codebase.
 */
export function isAppHostDirectory(dirPath: string): boolean {
  try {
    const norm = dirPath.toLowerCase().replace(/\\/g, "/");
    if (norm.includes("/antigravity") || norm.includes("/appdata/local/programs/antigravity")) {
      // Check if it has Electron app runtime signatures
      if (
        existsSync(join(dirPath, "resources", "app.asar")) ||
        existsSync(join(dirPath, "resources", "app.asar.unpacked")) ||
        existsSync(join(dirPath, "locales"))
      ) {
        return true;
      }
    }
  } catch {
    // Ignore error
  }
  return false;
}

/**
 * Discovers the project root directory by walking up looking for marker files.
 */
export function findProjectRoot(fromPath: string): string {
  try {
    let dir = resolve(fromPath);

    if (existsSync(dir)) {
      const stat = statSync(dir);
      if (!stat.isDirectory()) {
        dir = dirname(dir);
      }
    } else {
      dir = dirname(dir);
    }

    let current = dir;
    while (true) {
      // Don't treat an app host directory as a project root
      if (!isAppHostDirectory(current)) {
        for (const marker of PROJECT_ROOT_MARKERS) {
          if (existsSync(join(current, marker))) {
            return canonicalizePath(current);
          }
        }
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    // Filesystem traversal error fallback
  }

  return canonicalizePath(dirname(resolve(fromPath)));
}

/**
 * Ergonomically resolves the active workspace root:
 * 1. Explicit pathHint (if provided and valid).
 * 2. SEPTUM_WORKSPACE_ROOT environment variable.
 * 3. lastKnownProjectRoot (if cached from earlier tool calls).
 * 4. findProjectRoot from process.cwd() (if not an app host directory).
 */
export function resolveWorkspaceRoot(pathHint?: string): string {
  if (pathHint && typeof pathHint === "string" && pathHint.trim()) {
    const trimmed = pathHint.trim().replace(/^['"]|['"]$/g, "");
    const candidate = findProjectRoot(trimmed);
    if (candidate && existsSync(candidate) && !isAppHostDirectory(candidate)) {
      setLastKnownProjectRoot(candidate);
      return candidate;
    }
  }

  const envRoot = process.env.SEPTUM_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT;
  if (envRoot && existsSync(envRoot) && !isAppHostDirectory(envRoot)) {
    const candidate = canonicalizePath(envRoot);
    setLastKnownProjectRoot(candidate);
    return candidate;
  }

  if (lastKnownProjectRoot && existsSync(lastKnownProjectRoot)) {
    return lastKnownProjectRoot;
  }

  const cwd = process.cwd();
  if (!isAppHostDirectory(cwd)) {
    const candidate = findProjectRoot(cwd);
    setLastKnownProjectRoot(candidate);
    return candidate;
  }

  // Fallback if inside app host directory: keep looking in lastKnown or return cwd
  return canonicalizePath(cwd);
}
