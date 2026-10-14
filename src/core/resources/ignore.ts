export function shouldIgnoreSourcePath(filePath: string, ignorePatterns: string[]): boolean {
    if (filePath.replace(/\\/g, "/").split("/").some(segment => ["node_modules", "vendor", ".git", ".septum", ".strata", ".codegraph", "dist", "build", ".output", ".nuxt", ".next", ".cache", "coverage", ".turbo"].includes(segment))) return true;
    const normPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
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

      const segments = normPath.split("/");
      if (segments.includes(normPattern)) {
        return true;
      }
    }
    return false;
  }

