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

/**
 * Calculates the maximum control flow nesting depth within a code block (PHP, TS, JS, Go).
 * Base depth is 1 (the function body itself).
 * Nested control structures (if, else if, for, foreach, while, do, switch, try, catch)
 * that open a block increase the active depth.
 */
export function calculateControlFlowNesting(
  lines: string[],
  startLineIndex: number,
  endLineIndex: number
): number {
  if (startLineIndex >= endLineIndex) return 1;

  let maxDepth = 1;
  let currentDepth = 1;
  let inMultiLineComment = false;
  let insideBody = false;

  const controlStack: number[] = [];
  let braceDepth = 0;
  let pendingControl = false;

  const controlRegex = /\b(if|else\s+if|else|for|foreach|while|do|switch|try|catch)\b/;

  const startIdx = Math.max(0, startLineIndex);
  const endIdx = Math.min(lines.length - 1, endLineIndex);

  for (let i = startIdx; i <= endIdx; i++) {
    const rawLine = lines[i];

    let cleanLine = "";
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplateString = false;

    for (let j = 0; j < rawLine.length; j++) {
      const char = rawLine[j];
      const prevChar = j > 0 ? rawLine[j - 1] : "";
      const nextChar = j + 1 < rawLine.length ? rawLine[j + 1] : "";

      if (inMultiLineComment) {
        if (char === "*" && nextChar === "/") {
          inMultiLineComment = false;
          j++;
        }
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && !inTemplateString && char === "/" && nextChar === "*") {
        inMultiLineComment = true;
        j++;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && !inTemplateString && char === "/" && nextChar === "/") {
        break; // Single line comment: ignore rest of line
      }

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

      cleanLine += char;
    }

    const trimmedClean = cleanLine.trim();
    if (!trimmedClean) continue;

    if (insideBody && controlRegex.test(trimmedClean)) {
      pendingControl = true;
    }

    for (let j = 0; j < cleanLine.length; j++) {
      const char = cleanLine[j];
      if (char === "{") {
        braceDepth++;
        if (!insideBody) {
          insideBody = true;
        } else if (pendingControl) {
          currentDepth++;
          controlStack.push(braceDepth);
          if (currentDepth > maxDepth) {
            maxDepth = currentDepth;
          }
          pendingControl = false;
        }
      } else if (char === "}") {
        if (controlStack.length > 0 && controlStack[controlStack.length - 1] === braceDepth) {
          controlStack.pop();
          currentDepth = Math.max(1, currentDepth - 1);
        }
        braceDepth = Math.max(0, braceDepth - 1);
      }
    }

    if (trimmedClean.endsWith(";")) {
      pendingControl = false;
    }
  }

  return maxDepth;
}

/**
 * Calculates the maximum control flow nesting depth in indentation-based languages (Python).
 */
export function calculatePythonNesting(
  lines: string[],
  startLineIndex: number,
  endLineIndex: number
): number {
  if (startLineIndex >= endLineIndex) return 1;

  const startLine = lines[startLineIndex];
  const baseIndentMatch = startLine.match(/^(\s*)/);
  const baseIndent = baseIndentMatch ? baseIndentMatch[1].length : 0;

  const controlRegex = /^\s*(if|elif|else|for|while|try|except|finally|match|case)\b/;
  const indentStack: number[] = [baseIndent];
  let maxDepth = 1;

  const startIdx = Math.max(0, startLineIndex + 1);
  const endIdx = Math.min(lines.length - 1, endLineIndex);

  for (let i = startIdx; i <= endIdx; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const currentIndentMatch = line.match(/^(\s*)/);
    const currentIndent = currentIndentMatch ? currentIndentMatch[1].length : 0;

    while (indentStack.length > 1 && currentIndent <= indentStack[indentStack.length - 1]) {
      indentStack.pop();
    }

    if (controlRegex.test(line)) {
      indentStack.push(currentIndent);
      if (indentStack.length > maxDepth) {
        maxDepth = indentStack.length;
      }
    }
  }

  return maxDepth;
}
