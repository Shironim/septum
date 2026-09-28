import type {
  ExtractedDependency,
  ExtractedSymbol,
  ParsedFileAST,
} from "../../../types/index.ts";
import type { CodeExtractor } from "./base.ts";

export class BladeExtractor implements CodeExtractor {
  public canHandle(filePath: string): boolean {
    return /\.blade\.php$/i.test(filePath);
  }

  public async extract(filePath: string, content: string): Promise<ParsedFileAST> {
    const symbols: ExtractedSymbol[] = [];
    const dependencies: ExtractedDependency[] = [];

    const lines = content.split(/\r?\n/);
    const lineCount = lines.length;

    // 1. Register the view itself as a top-level symbol
    const viewName = this.normalizeViewName(filePath);
    if (viewName) {
      symbols.push({
        name: viewName,
        kind: "view",
        signature: `@view(${viewName})`,
        visibility: "public",
        line_start: 1,
        line_end: Math.max(1, lineCount),
        line_count: Math.max(1, lineCount),
      });

      // Also register with view: prefix for explicit queries
      symbols.push({
        name: `view:${viewName}`,
        kind: "view",
        signature: `@view(${viewName})`,
        visibility: "public",
        line_start: 1,
        line_end: Math.max(1, lineCount),
        line_count: Math.max(1, lineCount),
      });
    }

    // 2. Line-by-line scanning for Blade directives, components, and DOM IDs
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      if (!trimmed) continue;

      // Extends: @extends('layouts.app')
      const extendsMatch = /@extends\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(trimmed);
      if (extendsMatch) {
        dependencies.push({
          target: extendsMatch[1],
          statement: trimmed,
          line_number: lineNum,
          is_external: false,
        });
      }

      // Includes: @include('partials.store_card'), @includeIf, @includeWhen, @includeUnless
      const includeRegex = /@include(?:If|When|Unless)?\s*\(\s*['"]([^'"]+)['"]/g;
      let incMatch: RegExpExecArray | null;
      while ((incMatch = includeRegex.exec(trimmed)) !== null) {
        dependencies.push({
          target: incMatch[1],
          statement: trimmed,
          line_number: lineNum,
          is_external: false,
        });
      }

      // Blade Components: <x-store.search-bar or <x-alert
      const componentRegex = /<x-([a-zA-Z0-9_.\-]+)/g;
      let compMatch: RegExpExecArray | null;
      while ((compMatch = componentRegex.exec(trimmed)) !== null) {
        const compTag = compMatch[1];
        // Convert foo-bar to components.foo-bar or components.foo.bar
        const compTarget = `components.${compTag.replace(/-/g, ".")}`;
        dependencies.push({
          target: compTarget,
          statement: trimmed,
          line_number: lineNum,
          is_external: false,
        });
        symbols.push({
          name: `<x-${compTag}>`,
          kind: "component",
          signature: `<x-${compTag}>`,
          visibility: "public",
          line_start: lineNum,
          line_end: lineNum,
          line_count: 1,
        });
      }

      // Livewire: @livewire('search-dropdown')
      const livewireMatch = /@livewire\s*\(\s*['"]([^'"]+)['"]/.exec(trimmed);
      if (livewireMatch) {
        dependencies.push({
          target: `livewire:${livewireMatch[1]}`,
          statement: trimmed,
          line_number: lineNum,
          is_external: false,
        });
      }

      // Section: @section('content')
      const sectionMatch = /@section\s*\(\s*['"]([^'"]+)['"]/.exec(trimmed);
      if (sectionMatch) {
        symbols.push({
          name: `section:${sectionMatch[1]}`,
          kind: "property",
          signature: `@section('${sectionMatch[1]}')`,
          visibility: "public",
          line_start: lineNum,
          line_end: lineNum,
          line_count: 1,
        });
      }

      // DOM ID attribute: id="laptop-slider" or id='laptop-slider'
      const idMatch = /\bid=["']([a-zA-Z0-9_\-]+)["']/.exec(trimmed);
      if (idMatch) {
        const elementId = idMatch[1];
        symbols.push({
          name: `#${elementId}`,
          kind: "property",
          signature: `id="${elementId}"`,
          visibility: "public",
          line_start: lineNum,
          line_end: lineNum,
          line_count: 1,
        });
      }
    }

    return { symbols, dependencies };
  }

  /**
   * Derive Laravel view name from path, e.g.:
   * resources/views/partials/store_card.blade.php -> partials.store_card
   */
  private normalizeViewName(filePath: string): string | null {
    const clean = filePath.replace(/\\/g, "/");
    const viewsIdx = clean.indexOf("views/");
    if (viewsIdx !== -1) {
      const sub = clean.slice(viewsIdx + 6).replace(/\.blade\.php$/i, "");
      return sub.replace(/\//g, ".");
    }
    const base = clean.split("/").pop()?.replace(/\.blade\.php$/i, "");
    return base || null;
  }
}
