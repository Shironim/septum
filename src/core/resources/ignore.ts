export const DEFAULT_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  // Package managers & dependencies (visible & hidden)
  "node_modules",
  "vendor",
  "bower_components",
  "jspm_packages",

  // Build, bundle & compilation outputs (visible & hidden)
  "dist",
  "build",
  "out",
  "output",
  ".output",
  "target",
  "obj",
  "bin",
  "scripts",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  ".svelte-kit",
  ".astro",
  ".docusaurus",

  // Python virtual environments and bytecode caches
  ".venv",
  "venv",
  "env",
  ".env",
  "virtualenv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",

  // Test coverage
  "coverage",
  ".nyc_output",

  // Version control & repository metadata
  ".git",
  ".svn",
  ".hg",
  ".github",
  ".gitlab",

  // Tooling, agent & IDE metadata
  ".septum",
  ".strata",
  ".codegraph",
  ".system_generated",
  ".gemini",
  ".claude",
  ".agents",
  ".codex",
  "opencode",
  ".opencode",
  ".cursor",
  ".vscode",
  ".idea",
  ".codex-evidence",
  ".antigravity",
  ".cline",
  ".roo",
  ".windsurf",
  ".continue",
  ".copilot",
  ".chat",

  // Cache & Temp
  ".cache",
  "tmp",
  "temp",
  ".sass-cache",
]);

export function isIgnoredDirectory(dirName: string): boolean {
  if (!dirName || dirName === "." || dirName === "..") return false;
  return DEFAULT_IGNORED_DIRECTORIES.has(dirName) || dirName.startsWith(".");
}

export function shouldIgnoreSourcePath(filePath: string, ignorePatterns: string[] = []): boolean {
  const normPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normPath.split("/");

  // Fast check: if any segment is a standard ignored directory or hidden directory/file
  if (segments.some(segment => isIgnoredDirectory(segment))) {
    return true;
  }

  for (const pattern of ignorePatterns) {
    const normPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!normPattern) continue;

    if (normPattern === "*" || normPattern === "**") {
      return true;
    }

    if (normPath === normPattern) return true;

    if (normPattern.endsWith("/**")) {
      const prefix = normPattern.slice(0, -3);
      if (normPath === prefix || normPath.startsWith(prefix + "/")) return true;
    } else if (normPattern.endsWith("/*")) {
      const prefix = normPattern.slice(0, -2);
      if (normPath === prefix || normPath.startsWith(prefix + "/")) return true;
    } else if (normPath.startsWith(normPattern + "/")) {
      return true;
    }

    if (normPattern.startsWith("*.") && normPath.endsWith(normPattern.slice(1))) {
      return true;
    }

    if (segments.includes(normPattern)) {
      return true;
    }
  }
  return false;
}

