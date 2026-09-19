import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
import { findPythonBlockEnd } from "../boundary-tracker.ts";
import type { CodeExtractor } from "./base.ts";

const PYTHON_STDLIB_AND_EXTERNALS = new Set([
  "os",
  "sys",
  "json",
  "math",
  "typing",
  "re",
  "datetime",
  "time",
  "collections",
  "itertools",
  "functools",
  "pathlib",
  "io",
  "logging",
  "subprocess",
  "threading",
  "multiprocessing",
  "asyncio",
  "abc",
  "copy",
  "enum",
  "dataclasses",
  "uuid",
  "hashlib",
  "random",
  "socket",
  "unittest",
  // Common 3rd party frameworks
  "pydantic",
  "fastapi",
  "django",
  "flask",
  "sqlalchemy",
  "celery",
  "numpy",
  "pandas",
  "requests",
  "httpx",
  "pytest",
  "starlette",
  "alembic",
  "redis",
]);

export class PythonExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return /\.py$/i.test(filePath);
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const lines = content.split("\n");

    // 1. Extract Python Imports
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // Skip comments
      if (trimmed.startsWith("#")) continue;

      // Pattern A: from <module> import <symbols>
      const fromMatch = /^from\s+([.\w]+)\s+import\s+([*\w\s,()]+)/.exec(trimmed);
      if (fromMatch) {
        const modulePath = fromMatch[1];
        const isRelative = modulePath.startsWith(".");
        const topPackage = isRelative ? "" : modulePath.split(".")[0];
        const isExternal = !isRelative && PYTHON_STDLIB_AND_EXTERNALS.has(topPackage);

        dependencies.push({
          target: modulePath,
          statement: trimmed,
          line_number: lineNum,
          is_external: isExternal,
        });
        continue;
      }

      // Pattern B: import <module> [as <alias>]
      const importMatch = /^import\s+([.\w]+)(?:\s+as\s+\w+)?/.exec(trimmed);
      if (importMatch) {
        const modulePath = importMatch[1];
        const topPackage = modulePath.split(".")[0];
        const isExternal = PYTHON_STDLIB_AND_EXTERNALS.has(topPackage);

        dependencies.push({
          target: modulePath,
          statement: trimmed,
          line_number: lineNum,
          is_external: isExternal,
        });
      }
    }

    // 2. Extract Python Classes and Functions
    let currentClass: string | null = null;
    let currentClassIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      if (!trimmed || trimmed.startsWith("#")) continue;

      const indentMatch = /^(\s*)/.exec(line);
      const indent = indentMatch ? indentMatch[1].length : 0;

      // Check if we exited current class scope
      if (currentClass !== null && indent <= currentClassIndent) {
        currentClass = null;
        currentClassIndent = -1;
      }

      // Class Definition
      const classMatch = /^class\s+([A-Za-z0-9_]+)(?:\s*\([^)]*\))?\s*:/.exec(trimmed);
      if (classMatch) {
        const className = classMatch[1];
        currentClass = className;
        currentClassIndent = indent;

        const visibility: Visibility = className.startsWith("__")
          ? "private"
          : className.startsWith("_")
          ? "protected"
          : "public";

        const endLine = findPythonBlockEnd(lines, i);
        symbols.push({
          name: className,
          kind: "class",
          signature: trimmed.replace(/:$/, "").trim(),
          visibility,
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
        continue;
      }

      // Class Attributes or Pydantic fields inside class
      if (currentClass !== null && indent > currentClassIndent) {
        const attrMatch = /^([A-Za-z0-9_]+)\s*(?::\s*([^=]+))?(?:\s*=\s*(.+))?$/.exec(trimmed);
        if (
          attrMatch &&
          !trimmed.startsWith("def ") &&
          !trimmed.startsWith("async def ") &&
          !["return", "pass", "raise", "assert", "import", "from", "yield"].includes(attrMatch[1])
        ) {
          const attrName = attrMatch[1];
          const visibility: Visibility = attrName.startsWith("__")
            ? "private"
            : attrName.startsWith("_")
            ? "protected"
            : "public";

          symbols.push({
            name: `${currentClass}::${attrName}`,
            kind: "property",
            signature: trimmed,
            visibility,
            line_start: lineNum,
            line_end: lineNum,
            line_count: 1,
          });
          continue;
        }
      }

      // Module-level UPPERCASE constants: MAX_RETRIES = 5
      if (currentClass === null && indent === 0) {
        const constMatch = /^([A-Z][A-Z0-9_]*)\s*(?::\s*([^=]+))?\s*=\s*(.+)$/.exec(trimmed);
        if (constMatch) {
          const constName = constMatch[1];
          symbols.push({
            name: constName,
            kind: "property",
            signature: trimmed,
            visibility: "public",
            line_start: lineNum,
            line_end: lineNum,
            line_count: 1,
          });
          continue;
        }
      }

      // Function or Method Definition
      const funcMatch = /^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*[^:]+)?\s*:/.exec(trimmed);
      if (funcMatch) {
        const funcName = funcMatch[1];
        const isMethod = currentClass !== null && indent > currentClassIndent;

        const visibility: Visibility = funcName.startsWith("__")
          ? "private"
          : funcName.startsWith("_")
          ? "protected"
          : "public";

        const endLine = findPythonBlockEnd(lines, i);
        symbols.push({
          name: isMethod ? `${currentClass}::${funcName}` : funcName,
          kind: isMethod ? "method" : "function",
          signature: trimmed.replace(/:$/, "").trim(),
          visibility,
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
        });
      }
    }

    return {
      symbols,
      dependencies,
    };
  }
}
