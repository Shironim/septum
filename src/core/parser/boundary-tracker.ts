/**
 * Utility to find the end line (1-based index) of a code block.
 * Handles brace matching with string and comment awareness for C-like languages (TS, JS, PHP, Go).
 */
export function findBraceBlockEnd(lines: string[], startLineIndex: number): number {
  let depth = 0;
  let hasOpened = false;
  let inMultiLineComment = false;

  for (let i = startLineIndex; i < lines.length; i++) {
    const line = lines[i];
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateString = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      const prevChar = j > 0 ? line[j - 1] : "";
      const nextChar = j + 1 < line.length ? line[j + 1] : "";

      // Multi-line comment boundary
      if (inMultiLineComment) {
        if (char === "*" && nextChar === "/") {
          inMultiLineComment = false;
          j++; // skip '/'
        }
        continue;
      }

      // Check start of multi-line comment /*
      if (!inSingleQuote && !inDoubleQuote && !inTemplateString && char === "/" && nextChar === "*") {
        inMultiLineComment = true;
        j++;
        continue;
      }

      // Check single-line comment //
      if (!inSingleQuote && !inDoubleQuote && !inTemplateString && char === "/" && nextChar === "/") {
        break; // ignore rest of line
      }

      // String quote handling (with escape character check)
      if (char === "'" && !inDoubleQuote && !inTemplateString && prevChar !== "\\") {
        inSingleQuote = !inSingleQuote;
        continue;
      }
      if (char === '"' && !inSingleQuote && !inTemplateString && prevChar !== "\\") {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }
      if (char === "`" && !inSingleQuote && !inDoubleQuote && prevChar !== "\\") {
        inTemplateString = !inTemplateString;
        continue;
      }

      if (inSingleQuote || inDoubleQuote || inTemplateString) {
        continue;
      }

      // Brace tracking
      if (char === "{") {
        depth++;
        hasOpened = true;
      } else if (char === "}") {
        if (hasOpened) {
          depth--;
          if (depth === 0) {
            return i + 1; // 1-based line number
          }
        }
      }
    }

    // Safety guard: If we haven't seen an opening brace within 40 lines or hit a declaration-only statement
    if (!hasOpened) {
      const trimmed = line.trim();
      if (trimmed.endsWith(";") && i > startLineIndex) {
        return i + 1;
      }
      if (i - startLineIndex > 40) {
        return startLineIndex + 1;
      }
    }
  }

  // Fallback: If braces were unclosed or not found, return start line
  return startLineIndex + 1;
}

/**
 * Utility to find the end line (1-based index) of an indentation-based block (Python).
 */
export function findPythonBlockEnd(lines: string[], startLineIndex: number): number {
  if (startLineIndex >= lines.length) return startLineIndex + 1;

  const startLine = lines[startLineIndex];
  const baseIndentMatch = startLine.match(/^(\s*)/);
  const baseIndent = baseIndentMatch ? baseIndentMatch[1].length : 0;

  let lastContentLine = startLineIndex + 1;
  let bodyStarted = false;

  for (let i = startLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines or pure comment lines
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const currentIndentMatch = line.match(/^(\s*)/);
    const currentIndent = currentIndentMatch ? currentIndentMatch[1].length : 0;

    if (currentIndent > baseIndent) {
      bodyStarted = true;
      lastContentLine = i + 1;
    } else {
      // Returned to same or lesser indentation -> block ended
      if (bodyStarted) {
        return lastContentLine;
      }
      break;
    }
  }

  return lastContentLine;
}
