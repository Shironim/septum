import { readSourceFile } from "../resources/source-files.ts";
import { computeContentHash } from "../ingestion/hasher.ts";
import { assertPathContained } from "./path-resolver.ts";
import { join, relative, resolve } from "node:path";
import { collectSourceSkips } from "../resources/source-files.ts";
import type {
  ExecutionChainNode,
  VerticalSliceRecord,
  VerticalSliceTraceResponse,
} from "../../types/index.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { CallGraphTracer } from "./call-graph-tracer.ts";
import { SemanticSliceExtractorRegistry } from "../parser/extractors/registry.ts";
import { TopologyDetector } from "../discovery/topology-detector.ts";
import { readdirSync } from "node:fs";
import { ASTParserEngine } from "../parser/tree-sitter.ts";
import { shouldIgnoreSourcePath } from "../resources/ignore.ts";

export class VerticalSliceTracer {
  constructor(private repo: SeptumRepository, private projectRoot: string = process.cwd(), private ignorePatterns: string[] = [], private verifyMembership = true) {}

  public async traceAsync(rawQuery: string, maxDepth = 5, signal?: AbortSignal): Promise<VerticalSliceTraceResponse> {
    signal?.throwIfAborted();
    if (this.repo.getMeta("sync_state") === "error" || this.repo.getMeta("sync_state") === "running") {
      return { query: rawQuery, found: false, coverage: "partial", diagnostics: ["index_incomplete"], message: "Workspace synchronization is incomplete." };
    }
    let inputsChanged = false;
    let membershipChanged = false;
    try {
      const inputs = JSON.parse(this.repo.getMeta("semantic_inputs") || "[]") as Array<{path:string;hash:string}>;
      inputsChanged = inputs.some(input => {
        signal?.throwIfAborted();
        assertPathContained(input.path,this.projectRoot,"Semantic source");
        return computeContentHash(readSourceFile(resolve(this.projectRoot,input.path))) !== input.hash;
      });
      if (this.verifyMembership) {
        const files = this.listSourceFiles(this.projectRoot);
        membershipChanged = JSON.stringify(files) !== (this.repo.getMeta("semantic_catalog_files") || "[]");
      }
    } catch { signal?.throwIfAborted(); inputsChanged = true; }
    if (inputsChanged || membershipChanged || this.repo.getAllVerticalSlices().length === 0 || this.repo.getMeta("slices_dirty") === "1") {
      try {
        const topology = TopologyDetector.detect(this.projectRoot);
        const extracted = await collectSourceSkips(this.projectRoot, async () => {
          const slices = await SemanticSliceExtractorRegistry.extractAllSlices(this.projectRoot,topology.framework,undefined,signal);
          return slices.length ? slices : new CallGraphTracer(this.repo,this.projectRoot).traceAllSlices(maxDepth);
        });
        signal?.throwIfAborted();
        if (extracted.skipped.length) throw new Error("Semantic source exceeds read limits; catalog is incomplete.");
        this.repo.runInTransaction(() => {
          signal?.throwIfAborted();
          this.repo.clearVerticalSlices();
          for (const slice of extracted.value) this.repo.upsertVerticalSlice(slice);
          this.repo.setMeta("slices_dirty", "");
          this.repo.setMeta("semantic_inputs", JSON.stringify(extracted.inputs));
          if (this.verifyMembership) this.repo.setMeta("semantic_catalog_files", JSON.stringify(this.listSourceFiles(this.projectRoot)));
        });
      } catch (error) {
        signal?.throwIfAborted();
        this.repo.setMeta("slices_dirty", "1");
        return { query: rawQuery, found: false, coverage: "partial", diagnostics: [error instanceof Error ? error.message : String(error)], message: "Semantic extraction failed; no complete catalog was published." };
      }
    }
    return this.trace(rawQuery,maxDepth);
  }

  private listSourceFiles(root: string): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        const relPath = relative(root, fullPath).replace(/\\/g, "/");
        if (shouldIgnoreSourcePath(relPath, this.ignorePatterns)) continue;
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.isFile() && ASTParserEngine.isSourceFile(fullPath)) files.push(relPath);
      }
    };
    walk(root);
    return files.sort();
  }

  /**
   * Trace an end-to-end vertical slice from route/action/intent query.
   * Examples of queries:
   *  - "POST /orders/{id}/status"
   *  - "/orders/{id}/status"
   *  - "OrderController@updateStatus"
   *  - "OrderController::updateStatus"
   *  - "orders.update_status"
   *  - "createOrder"
   *  - "Ubah status order di dashboard"
   */
  // Synchronous compatibility API reads persisted slices only; use traceAsync for on-demand extraction.
  public trace(rawQuery: string, maxDepth: number = 5): VerticalSliceTraceResponse {
    const effectiveMaxDepth = Math.min(Math.max(Math.trunc(maxDepth || 5), 1), 8);
    const trimmed = rawQuery.trim();
    const lowerTrimmed = trimmed.toLowerCase();
    let allSlices = this.repo.getAllVerticalSlices();

    if (allSlices.length === 0) {
      return {
        query: trimmed,
        found: false,
        max_depth_applied: effectiveMaxDepth,
        message: "No vertical slices cataloged. Run 'septum sync' to extract framework routes and MVC slices.",
      };
    }

    // 1. Exact HTTP Method + URI match: "POST /orders/{id}/status" or "POST /api/orders"
    const methodUriMatch = trimmed.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s]+)$/i);
    if (methodUriMatch) {
      const httpMethod = methodUriMatch[1].toUpperCase();
      const uri = methodUriMatch[2];
      const candidates = allSlices.filter((s) => s.http_method.toUpperCase() === httpMethod && this.urisMatch(s.route_uri, uri));
      const literal = candidates.filter(s => s.route_uri === uri);
      if (literal.length === 1) {
        return this.formatSuccessResponse(trimmed, literal[0], "exact", undefined, effectiveMaxDepth);
      }
      if (literal.length > 1 || candidates.length > 1) {
        return this.formatSuccessResponse(trimmed, literal[0] ?? candidates[0], "inferred", (literal.length ? literal : candidates).slice(1), effectiveMaxDepth);
      }
      if (candidates.length === 1) {
        return this.formatSuccessResponse(trimmed, candidates[0], "inferred", undefined, effectiveMaxDepth);
      }
      return { query: trimmed, found: false, max_depth_applied: effectiveMaxDepth, message: `No vertical slice found matching query '${trimmed}'.` };
    }

    // 2. URI-only match: "/orders" or "orders/{id}"
    const literalUriMatches = allSlices.filter((s) => s.route_uri === trimmed);
    const uriMatches = literalUriMatches.length ? literalUriMatches : allSlices.filter((s) => this.urisMatch(s.route_uri, trimmed));
    if (uriMatches.length > 0) {
      const confidence = literalUriMatches.length ? "exact" : "inferred";
      if (uriMatches.length === 1) {
        return this.formatSuccessResponse(trimmed, uriMatches[0], confidence, undefined, effectiveMaxDepth);
      }
      // Multiple matches (e.g. GET /orders and POST /orders) -> return primary with alternatives
      return this.formatSuccessResponse(trimmed, uriMatches[0], confidence, uriMatches.slice(1), effectiveMaxDepth);
    }

    // 3. Named Route match: "orders.status.update" or "admin.users.index"
    const nameMatch = allSlices.find(
      (s) => s.route_name && s.route_name.toLowerCase() === lowerTrimmed
    );
    if (nameMatch) {
      return this.formatSuccessResponse(trimmed, nameMatch, "exact", undefined, effectiveMaxDepth);
    }

    // 3b. Omni-Trigger Match: "JOB ProcessOrderJob", "job:ProcessOrderJob", "CLI order:cleanup", "EVENT OrderPlacedListener"
    const omniTriggerMatch = trimmed.match(/^(JOB|CLI|EVENT)\s+([A-Za-z0-9_:\-]+)$/i);
    if (omniTriggerMatch) {
      const triggerKind = omniTriggerMatch[1].toUpperCase();
      const targetName = omniTriggerMatch[2].toLowerCase();
      const exact = allSlices.find(
        (s) =>
          s.http_method.toUpperCase() === triggerKind &&
          (s.controller_class.toLowerCase() === targetName ||
            s.route_uri.toLowerCase() === targetName ||
            s.route_uri.toLowerCase() === `${triggerKind.toLowerCase()}:${targetName}`)
      );
      if (exact) {
        return this.formatSuccessResponse(trimmed, exact, "exact", undefined, effectiveMaxDepth);
      }
    }

    // 4. Controller@Action match: "OrderController@updateStatus" or "OrderController"
    const controllerActionMatch = trimmed.match(/^([A-Za-z0-9_\\/.]+?)(?:(?:@|::)([A-Za-z0-9_]+))?$/);
    if (controllerActionMatch) {
      const [, rawCtrl, act] = controllerActionMatch;
      const ctrl = rawCtrl.split(/[\\/]/).pop()?.replace(/\.(php|ts|js)$/i, "") || rawCtrl;
      const lowerCtrl = ctrl.toLowerCase();
      const lowerAct = act ? act.toLowerCase() : undefined;

      const exact = allSlices.find((s) => {
        const sCtrlLower = s.controller_class.toLowerCase();
        const ctrlMatch =
          sCtrlLower === lowerCtrl ||
          sCtrlLower.endsWith(`\\${lowerCtrl}`) ||
          sCtrlLower.endsWith(`/${lowerCtrl}`);
        if (!ctrlMatch) return false;
        if (lowerAct) return s.action_name.toLowerCase() === lowerAct;
        if (!act && !lowerCtrl.endsWith("controller") && sCtrlLower !== lowerCtrl) {
          return false;
        }
        return true;
      });
      if (exact) {
        return this.formatSuccessResponse(trimmed, exact, "exact", undefined, effectiveMaxDepth);
      }
    }

    // 5. Symbol Match in Execution Chain or Action Name (e.g. "createOrder", "CreateOrderUseCase", "OrderController")
    const symbolMatch = allSlices.find((s) => {
      if (s.action_name.toLowerCase() === lowerTrimmed) return true;
      if (s.controller_class.toLowerCase() === lowerTrimmed) return true;
      if (s.execution_chain_json) {
        try {
          const chain: ExecutionChainNode[] = JSON.parse(s.execution_chain_json);
          return chain.some(
            (node) =>
              node.symbol.toLowerCase() === lowerTrimmed ||
              node.symbol.toLowerCase().includes(lowerTrimmed) ||
              (node.file && node.file.toLowerCase().includes(lowerTrimmed))
          );
        } catch {
          return false;
        }
      }
      return false;
    });
    if (symbolMatch) {
      return this.formatSuccessResponse(trimmed, symbolMatch, "inferred", undefined, effectiveMaxDepth);
    }

    // 6. Semantic / Token Scoring for Natural Language (e.g. "Ubah status order di dashboard")
    const tokens = this.tokenize(trimmed);
    const scoredSlices = allSlices
      .map((slice) => {
        let score = 0;
        const textCorpus = [
          slice.route_uri,
          slice.route_name || "",
          slice.controller_class,
          slice.action_name,
          slice.execution_chain_json || "",
        ].join(" ").toLowerCase();

        for (const token of tokens) {
          if (textCorpus.includes(token)) {
            score += 1;
            if (slice.route_uri.toLowerCase().includes(token)) score += 2;
            if (slice.action_name.toLowerCase().includes(token)) score += 2;
          }
        }
        return { slice, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scoredSlices.length > 0) {
      const primary = scoredSlices[0].slice;
      const alternatives = scoredSlices.slice(1, 4).map((item) => item.slice);
      return this.formatSuccessResponse(trimmed, primary, "inferred", alternatives, effectiveMaxDepth);
    }

    return {
      query: trimmed,
      found: false,
      max_depth_applied: effectiveMaxDepth,
      alternatives: allSlices.slice(0, 5).map((s) => ({
        method: s.http_method,
        uri: s.route_uri,
        controller: s.controller_class,
        action: s.action_name,
      })),
      message: `No vertical slice found matching query '${trimmed}'.`,
    };
  }

  private urisMatch(uriA: string, uriB: string): boolean {
    const normA = uriA
      .replace(/\{[^}]+\}/g, ":param")
      .replace(/:[a-zA-Z0-9_]+/g, ":param");
    const normB = uriB
      .replace(/\{[^}]+\}/g, ":param")
      .replace(/:[a-zA-Z0-9_]+/g, ":param");
    return normA === normB;
  }

  private tokenize(str: string): string[] {
    return str
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !["ubah", "di", "dan", "yang", "the", "for", "and"].includes(t));
  }

  private formatSuccessResponse(
    query: string,
    record: VerticalSliceRecord,
    confidence: "exact" | "inferred" = "exact",
    alternatives?: VerticalSliceRecord[],
    effectiveMaxDepth: number = 5
  ): VerticalSliceTraceResponse {
    let chain: ExecutionChainNode[] = [];
    if (record.execution_chain_json) {
      try {
        chain = JSON.parse(record.execution_chain_json);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Septum Slice Error] Corrupted execution chain JSON for slice ${record.id}: ${msg}`);
      }
    }

    // Import expansion is derived per request, so cached depth cannot override the requested hop limit.
    chain = chain.filter(node => node.relationship?.kind !== "imports" && !node.description?.includes("(dependency)"));
    if (
      record.controller_file &&
      typeof (this.repo as any).getAllFiles === "function"
    ) {
      try {
        const callGraphTracer = new CallGraphTracer(this.repo, this.projectRoot);
        chain = callGraphTracer.expandChainFromFile(
          record.controller_file,
          chain,
          effectiveMaxDepth
        );
      } catch {
        // Ignore expansion errors on mock/partial repositories
      }
    }

    let message = `Vertical slice resolved (${confidence}): ${record.http_method} ${record.route_uri} -> ${record.controller_class}@${record.action_name}`;
    if (chain.length > 0) {
      const stageLines = chain.map((node) => {
        const stageLabel = `[${node.stage.toUpperCase()}]`.padEnd(14, " ");
        const loc = node.file ? ` (${node.file}${node.line ? `:${node.line}` : ""})` : "";
        let extra = "";
        if (node.table) {
          extra += ` [table: ${node.table}]`;
        }
        if (node.columns_summary) {
          extra += ` {${node.columns_summary}}`;
        }
        if (node.guards && node.guards.length > 0 && node.stage !== "guard") {
          extra += ` [guards: ${node.guards.join(", ")}]`;
        }
        if (node.mutations && node.mutations.length > 0 && node.stage !== "side_effect") {
          extra += ` [mutates: ${node.mutations.join(", ")}]`;
        }
        if (node.transactions && node.stage !== "transaction") {
          extra += ` [tx: active]`;
        }
        return `${stageLabel} ${node.symbol}${loc}${extra}`;
      });
      message = `=== VERTICAL SLICE TRACE (${confidence.toUpperCase()}) ===\n` + stageLines.join("\n");
    }

    return {
      query,
      found: true,
      confidence,
      is_exact_match: confidence === "exact",
      architecture_style: record.architecture_style,
      max_depth_applied: effectiveMaxDepth,
      entrypoint: {
        method: record.http_method,
        uri: record.route_uri,
        name: record.route_name,
        controller: record.controller_class,
        action: record.action_name,
        file: record.controller_file,
        line: record.controller_line,
      },
      chain,
      slice: chain,
      alternatives: alternatives?.map((a) => ({
        method: a.http_method,
        uri: a.route_uri,
        controller: a.controller_class,
        action: a.action_name,
      })),
      message,
    };
  }
}
