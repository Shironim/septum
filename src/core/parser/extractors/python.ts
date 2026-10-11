import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
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

import type Parser from "web-tree-sitter";
import {
  blankCommentsAndStrings,
  calculatePythonNesting,
  findPythonBlockEnd,
} from "../boundary-tracker.ts";
import { calculateAstControlFlowNesting, parseWithTreeSitter } from "../wasm-loader.ts";

const PYTHON_CONTROL_FLOW_NODES = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "try_statement",
  "with_statement",
  "match_statement",
  "conditional_expression",
]);

const PYTHON_FUNCTION_BOUNDARY_NODES = new Set([
  "function_definition",
  "lambda",
]);

export class PythonExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return /\.py$/i.test(filePath);
  }

  public async extract(_filePath: string, content: string): Promise<ParsedFileAST> {
    const astResult = await parseWithTreeSitter("python", content, (rootNode) =>
      this.extractFromAst(rootNode, content)
    );
    if (astResult) {
      return astResult;
    }

    return this.extractFallback(content);
  }

  private extractFallback(content: string): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const lines = content.split("\n");
    const cleanLines = blankCommentsAndStrings(content, { hashComments: true }).split("\n");

    // 1. Extract Python Imports
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = cleanLines[i].trim();
      const rawTrimmed = line.trim();
      const lineNum = i + 1;

      if (!trimmed || trimmed.startsWith("#")) continue;

      // Pattern A: from <module> import <symbols>
      const fromMatch = /^from\s+([.\w]+)\s+import\s+([*\w\s,()]+)/.exec(trimmed);
      if (fromMatch) {
        const modulePath = fromMatch[1];
        const importedList = fromMatch[2]
          .replace(/[()]/g, " ")
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
          .filter((s) => Boolean(s) && s !== "*");
        const isRelative = modulePath.startsWith(".");
        const topPackage = isRelative ? "" : modulePath.split(".")[0];
        const isExternal = !isRelative && PYTHON_STDLIB_AND_EXTERNALS.has(topPackage);

        dependencies.push({
          target: modulePath,
          statement: rawTrimmed,
          line_number: lineNum,
          is_external: isExternal,
          ...(importedList.length > 0 ? { imported_symbols: importedList } : {}),
        });
        continue;
      }

      // Pattern B: import <module> [as <alias>]
      const importMatch = /^import\s+([.\w]+)(?:\s+as\s+(\w+))?/.exec(trimmed);
      if (importMatch) {
        const modulePath = importMatch[1];
        const alias = importMatch[2];
        const topPackage = modulePath.split(".")[0];
        const isExternal = PYTHON_STDLIB_AND_EXTERNALS.has(topPackage);
        const shortName = alias || modulePath.split(".").pop() || modulePath;

        dependencies.push({
          target: modulePath,
          statement: rawTrimmed,
          line_number: lineNum,
          is_external: isExternal,
          imported_symbols: [shortName],
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

        const endLine = findPythonBlockEnd(cleanLines, i);
        const nestingDepth = calculatePythonNesting(cleanLines, i, endLine - 1);
        symbols.push({
          name: isMethod ? `${currentClass}::${funcName}` : funcName,
          kind: isMethod ? "method" : "function",
          signature: trimmed.replace(/:$/, "").trim(),
          visibility,
          line_start: lineNum,
          line_end: endLine,
          line_count: Math.max(1, endLine - lineNum + 1),
          nesting_depth: nestingDepth,
        });
      }
    }

    return {
      symbols,
      dependencies,
    };
  }

  private extractFromAst(rootNode: Parser.SyntaxNode, content: string): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];
    const lines = content.split("\n");

    const getVisibility = (name: string): Visibility =>
      name.startsWith("__") ? "private" : name.startsWith("_") ? "protected" : "public";

    const processNode = (node: Parser.SyntaxNode, currentClass: string | null): void => {
      if (node.type === "import_from_statement") {
        const modNode =
          node.childForFieldName("module_name") ??
          node.namedChildren.find((c) => c.type === "dotted_name" || c.type === "relative_import");
        if (modNode) {
          const modulePath = modNode.text.trim();
          const isRelative = modulePath.startsWith(".");
          const topPackage = isRelative ? "" : modulePath.split(".")[0];
          const isExternal = !isRelative && PYTHON_STDLIB_AND_EXTERNALS.has(topPackage);
          const importedSymbols: string[] = [];

          for (const child of node.namedChildren) {
            if (child.equals(modNode)) continue;
            if (child.type === "dotted_name") {
              importedSymbols.push(child.text.trim());
            } else if (child.type === "aliased_import") {
              const orig = child.childForFieldName("name") ?? child.namedChildren[0];
              const alias = child.childForFieldName("alias") ?? child.namedChildren[1];
              if (orig?.text) importedSymbols.push(orig.text.trim());
              if (alias?.text) importedSymbols.push(alias.text.trim());
            }
          }

          dependencies.push({
            target: modulePath,
            statement: (lines[node.startPosition.row] ?? node.text).trim(),
            line_number: node.startPosition.row + 1,
            is_external: isExternal,
            ...(importedSymbols.length > 0 ? { imported_symbols: Array.from(new Set(importedSymbols)) } : {}),
          });
        }
        return;
      }

      if (node.type === "import_statement") {
        for (const child of node.namedChildren) {
          if (child.type === "dotted_name") {
            const modulePath = child.text.trim();
            const topPackage = modulePath.split(".")[0];
            const shortName = modulePath.split(".").pop() || modulePath;
            dependencies.push({
              target: modulePath,
              statement: (lines[node.startPosition.row] ?? node.text).trim(),
              line_number: node.startPosition.row + 1,
              is_external: PYTHON_STDLIB_AND_EXTERNALS.has(topPackage),
              imported_symbols: [shortName],
            });
          } else if (child.type === "aliased_import") {
            const orig = child.childForFieldName("name") ?? child.namedChildren[0];
            const alias = child.childForFieldName("alias") ?? child.namedChildren[1];
            if (orig) {
              const modulePath = orig.text.trim();
              const topPackage = modulePath.split(".")[0];
              const shortName = alias?.text?.trim() || modulePath.split(".").pop() || modulePath;
              dependencies.push({
                target: modulePath,
                statement: (lines[node.startPosition.row] ?? node.text).trim(),
                line_number: node.startPosition.row + 1,
                is_external: PYTHON_STDLIB_AND_EXTERNALS.has(topPackage),
                imported_symbols: [shortName],
              });
            }
          }
        }
        return;
      }

      if (node.type === "decorated_definition") {
        const defNode =
          node.childForFieldName("definition") ??
          node.namedChildren.find((c) => c.type === "class_definition" || c.type === "function_definition");
        if (defNode) {
          processNode(defNode, currentClass);
        }
        return;
      }

      if (node.type === "class_definition") {
        const nameNode = node.childForFieldName("name") ?? node.namedChildren.find((c) => c.type === "identifier");
        if (!nameNode) return;

        const className = nameNode.text;
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = (lines[node.startPosition.row] ?? "").trim().replace(/:$/, "").trim();

        symbols.push({
          name: className,
          kind: "class",
          signature: headerLine || `class ${className}`,
          visibility: getVisibility(className),
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
        });

        const bodyNode = node.childForFieldName("body") ?? node.namedChildren.find((c) => c.type === "block");
        if (bodyNode) {
          for (const stmt of bodyNode.namedChildren) {
            processNode(stmt, className);
          }
        }
        return;
      }

      if (node.type === "function_definition") {
        const nameNode = node.childForFieldName("name") ?? node.namedChildren.find((c) => c.type === "identifier");
        if (!nameNode) return;

        const funcName = nameNode.text;
        const isMethod = currentClass !== null;
        const lineStart = node.startPosition.row + 1;
        const lineEnd = Math.max(lineStart, node.endPosition.row + 1);
        const headerLine = (lines[node.startPosition.row] ?? "").trim().replace(/:$/, "").trim();
        const nestingDepth = calculateAstControlFlowNesting(
          node,
          PYTHON_CONTROL_FLOW_NODES,
          PYTHON_FUNCTION_BOUNDARY_NODES
        );

        symbols.push({
          name: isMethod ? `${currentClass}::${funcName}` : funcName,
          kind: isMethod ? "method" : "function",
          signature: headerLine || `def ${funcName}()`,
          visibility: getVisibility(funcName),
          line_start: lineStart,
          line_end: lineEnd,
          line_count: Math.max(1, lineEnd - lineStart + 1),
          nesting_depth: nestingDepth,
        });
        return;
      }

      if (node.type === "expression_statement") {
        const assignNode =
          node.namedChildren.find((c) => c.type === "assignment") ??
          (node.firstNamedChild?.type === "assignment" ? node.firstNamedChild : null);
        if (assignNode) {
          const leftNode = assignNode.childForFieldName("left") ?? assignNode.namedChildren[0];
          if (leftNode && leftNode.type === "identifier") {
            const varName = leftNode.text.trim();
            const lineStart = assignNode.startPosition.row + 1;
            const lineEnd = Math.max(lineStart, assignNode.endPosition.row + 1);
            const rawLine = (lines[assignNode.startPosition.row] ?? assignNode.text).trim();

            if (currentClass !== null) {
              symbols.push({
                name: `${currentClass}::${varName}`,
                kind: "property",
                signature: rawLine,
                visibility: getVisibility(varName),
                line_start: lineStart,
                line_end: lineEnd,
                line_count: Math.max(1, lineEnd - lineStart + 1),
              });
            } else if (/^[A-Z][A-Z0-9_]*$/.test(varName)) {
              symbols.push({
                name: varName,
                kind: "property",
                signature: rawLine,
                visibility: "public",
                line_start: lineStart,
                line_end: lineEnd,
                line_count: Math.max(1, lineEnd - lineStart + 1),
              });
            }
          }
        }
      }
    };

    for (const child of rootNode.namedChildren) {
      processNode(child, null);
    }

    return { symbols, dependencies };
  }
}

