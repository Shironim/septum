import { getLanguageCapability } from "../language-capabilities.ts";
import type { ExtractedDependency, ExtractedSymbol, ParsedFileAST, Visibility } from "../../../types/index.ts";
import { calculateAstControlFlowNesting, getNodeHeader, parseSourceWithTreeSitter } from "../wasm-loader.ts";
import type { CodeExtractor } from "./base.ts";
import type Parser from "web-tree-sitter";

const RUBY_CONTROL_FLOW_NODES = new Set([
  "if",
  "unless",
  "for",
  "while",
  "until",
  "case",
]);

const RUBY_FUNCTION_BOUNDARY_NODES = new Set([
  "method",
  "singleton_method",
]);

export class RubyExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return getLanguageCapability(filePath)?.extractor === "ruby";
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const astResult = await parseSourceWithTreeSitter("ruby", content, (rootNode) =>
      this.extractFromAst(rootNode, filePath, content),
      () => this.extractFallback(filePath, content)
    );
    if (astResult) {
      return astResult;
    }

    return { ...this.extractFallback(filePath, content), status: "degraded" };
  }

  private isExternalRequire(target: string, isRelative: boolean): boolean {
    if (isRelative || target.startsWith("./") || target.startsWith("../")) {
      return false;
    }
    return true;
  }

  private extractFromAst(
    rootNode: Parser.SyntaxNode,
    filePath: string,
    content: string
  ): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];
    const lines = content.split("\n");

    const processBlock = (node: Parser.SyntaxNode, scopeName?: string, visibility: Visibility = "public"): void => {
      let currentVisibility: Visibility = visibility;

      for (const child of node.namedChildren) {
        // Track visibility modifiers: private, protected, public
        if (child.type === "identifier" || child.type === "call" || child.type === "command") {
          const text = child.text.trim();
          if (text === "private") {
            currentVisibility = "private";
            continue;
          } else if (text === "protected") {
            currentVisibility = "protected";
            continue;
          } else if (text === "public") {
            currentVisibility = "public";
            continue;
          }

          // Check for require / require_relative calls
          const methodChild = child.childForFieldName("method") ?? child.namedChildren[0];
          const methodName = methodChild?.text;
          if (methodName === "private" || methodName === "protected" || methodName === "public") {
            const args = child.childForFieldName("arguments");
            if (args?.namedChildren.some(c => c.type === "method" || c.type === "singleton_method")) {
              processBlock(args, scopeName, methodName);
              continue;
            }
          }
          if (methodName === "require" || methodName === "require_relative") {
            const argsNode = child.childForFieldName("arguments") ?? child.namedChildren[1];
            if (argsNode) {
              const rawTarget = argsNode.text.replace(/^["':]|["']$/g, "").trim();
              const isRel = methodName === "require_relative";
              const leaf = rawTarget.split("/").pop() || rawTarget;

              dependencies.push({
                target: rawTarget,
                statement: (lines[child.startPosition.row] ?? child.text).trim(),
                line_number: child.startPosition.row + 1,
                is_external: this.isExternalRequire(rawTarget, isRel),
                imported_symbols: [leaf],
              });
            }
          }
        }

        if (child.type === "class" || child.type === "module") {
          const nameNode =
            child.childForFieldName("name") ??
            child.namedChildren.find((c) => c.type === "constant" || c.type === "scope_resolution");
          if (!nameNode) continue;

          const baseName = nameNode.text;
          const fullName = scopeName ? `${scopeName}::${baseName}` : baseName;
          const lineStart = child.startPosition.row + 1;
          const lineEnd = Math.max(lineStart, child.endPosition.row + 1);
          const headerLine = getNodeHeader(child);
          const kind = child.type === "class" ? "class" : "interface";

          symbols.push({
            name: fullName,
            kind,
            signature: headerLine || `${child.type} ${fullName}`,
            visibility: "public",
            line_start: lineStart,
            line_end: lineEnd,
            line_count: Math.max(1, lineEnd - lineStart + 1),
            nesting_depth: 1,
          });

          const bodyNode =
            child.childForFieldName("body") ??
            child.namedChildren.find((c) => c.type === "body_statement") ??
            child;
          processBlock(bodyNode, fullName);
          continue;
        }

        if (child.type === "method" || child.type === "singleton_method") {
          const nameNode =
            child.childForFieldName("name") ??
            child.namedChildren.find((c) => c.type === "identifier" || c.type === "constant");
          if (!nameNode) continue;

          const methodName = nameNode.text;
          const isClassMethod = child.type === "singleton_method";
          const fullName = scopeName
            ? `${scopeName}${isClassMethod ? "." : "#"}${methodName}`
            : methodName;
          const lineStart = child.startPosition.row + 1;
          const lineEnd = Math.max(lineStart, child.endPosition.row + 1);
          const headerLine = getNodeHeader(child);
          const nestingDepth = calculateAstControlFlowNesting(
            child,
            RUBY_CONTROL_FLOW_NODES,
            RUBY_FUNCTION_BOUNDARY_NODES
          );

          symbols.push({
            name: fullName,
            kind: scopeName ? "method" : "function",
            signature: headerLine || `def ${methodName}`,
            visibility: currentVisibility,
            line_start: lineStart,
            line_end: lineEnd,
            line_count: Math.max(1, lineEnd - lineStart + 1),
            nesting_depth: nestingDepth,
          });
          continue;
        }
      }
    };

    processBlock(rootNode);

    return { symbols, dependencies };
  }

  private extractFallback(filePath: string, content: string): ParsedFileAST {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      if (!trimmed || trimmed.startsWith("#")) continue;

      const requireMatch = /^(?:require|require_relative)\s+["']([^"']+)["']/.exec(trimmed);
      if (requireMatch) {
        const target = requireMatch[1].trim();
        const isRel = trimmed.startsWith("require_relative");
        const leaf = target.split("/").pop() || target;
        dependencies.push({
          target,
          statement: trimmed,
          line_number: lineNum,
          is_external: this.isExternalRequire(target, isRel),
          imported_symbols: [leaf],
        });
        continue;
      }

      const classMatch = /^(?:class|module)\s+([a-zA-Z0-9_:]+)/.exec(trimmed);
      if (classMatch) {
        const name = classMatch[1];
        symbols.push({
          name,
          kind: trimmed.startsWith("class") ? "class" : "interface",
          signature: trimmed,
          visibility: "public",
          line_start: lineNum,
          line_end: lineNum, // best effort in fallback
          line_count: 1,
          nesting_depth: 1,
        });
        continue;
      }

      const defMatch = /^def\s+([a-zA-Z0-9_.:]+)/.exec(trimmed);
      if (defMatch) {
        const name = defMatch[1];
        symbols.push({
          name,
          kind: "method",
          signature: trimmed,
          visibility: "public",
          line_start: lineNum,
          line_end: lineNum,
          line_count: 1,
          nesting_depth: 1,
        });
        continue;
      }
    }

    return { symbols, dependencies };
  }
}
