import type {
  ExecutionChainNode,
  VerticalSliceRecord,
  VerticalSliceTraceResponse,
} from "../../types/index.ts";
import type { SeptumRepository } from "../database/repository.ts";
import { CallGraphTracer } from "./call-graph-tracer.ts";

export class VerticalSliceTracer {
  constructor(private repo: SeptumRepository) {}

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
  public trace(rawQuery: string): VerticalSliceTraceResponse {
    const trimmed = rawQuery.trim();
    const lowerTrimmed = trimmed.toLowerCase();
    let allSlices = this.repo.getAllVerticalSlices();

    // Lazy fallback: If no slices cataloged, attempt heuristic call-graph tracing
    if (allSlices.length === 0) {
      try {
        const tracer = new CallGraphTracer(this.repo);
        const traced = tracer.traceAllSlices();
        if (traced.length > 0) {
          for (const s of traced) {
            this.repo.upsertVerticalSlice(s);
          }
          allSlices = this.repo.getAllVerticalSlices();
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Septum Slice Warning] Failed on-demand trace of vertical slices: ${msg}`);
      }
    }

    if (allSlices.length === 0) {
      return {
        query: trimmed,
        found: false,
        message: "No vertical slices cataloged. Run 'septum ingest' to extract framework routes and MVC slices.",
      };
    }

    // 1. Exact HTTP Method + URI match: "POST /orders/{id}/status" or "POST /api/orders"
    const methodUriMatch = trimmed.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s]+)$/i);
    if (methodUriMatch) {
      const httpMethod = methodUriMatch[1].toUpperCase();
      const uri = methodUriMatch[2].toLowerCase();
      const exact = allSlices.find(
        (s) =>
          s.http_method.toUpperCase() === httpMethod &&
          (s.route_uri.toLowerCase() === uri || this.urisMatch(s.route_uri, uri))
      );
      if (exact) {
        return this.formatSuccessResponse(trimmed, exact, "exact");
      }
    }

    // 2. URI-only match: "/orders" or "orders/{id}"
    const uriMatches = allSlices.filter((s) => s.route_uri.toLowerCase() === lowerTrimmed);
    if (uriMatches.length > 0) {
      if (uriMatches.length === 1) {
        return this.formatSuccessResponse(trimmed, uriMatches[0], "exact");
      }
      // Multiple matches (e.g. GET /orders and POST /orders) -> return primary with alternatives
      return this.formatSuccessResponse(trimmed, uriMatches[0], "exact", uriMatches.slice(1));
    }

    // 3. Named Route match: "orders.status.update" or "admin.users.index"
    const nameMatch = allSlices.find(
      (s) => s.route_name && s.route_name.toLowerCase() === lowerTrimmed
    );
    if (nameMatch) {
      return this.formatSuccessResponse(trimmed, nameMatch, "exact");
    }

    // 4. Controller@Action match: "OrderController@updateStatus" or "OrderController"
    const controllerActionMatch = trimmed.match(/^([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/);
    if (controllerActionMatch) {
      const [, ctrl, act] = controllerActionMatch;
      const lowerCtrl = ctrl.toLowerCase();
      const lowerAct = act ? act.toLowerCase() : undefined;

      const exact = allSlices.find((s) => {
        const ctrlMatch = s.controller_class.toLowerCase() === lowerCtrl || s.controller_class.toLowerCase().endsWith(lowerCtrl);
        if (!ctrlMatch) return false;
        if (lowerAct) return s.action_name.toLowerCase() === lowerAct;
        return true;
      });
      if (exact) {
        return this.formatSuccessResponse(trimmed, exact, "exact");
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
      return this.formatSuccessResponse(trimmed, symbolMatch, "inferred");
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
      return this.formatSuccessResponse(trimmed, primary, "inferred", alternatives);
    }

    return {
      query: trimmed,
      found: false,
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
    const normA = uriA.toLowerCase().replace(/\{[^}]+\}/g, ":param");
    const normB = uriB.toLowerCase().replace(/\{[^}]+\}/g, ":param").replace(/:[a-zA-Z0-9_]+/g, ":param");
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
    alternatives?: VerticalSliceRecord[]
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

    let message = `Vertical slice resolved (${confidence}): ${record.http_method} ${record.route_uri} -> ${record.controller_class}@${record.action_name}`;
    if (chain.length > 0) {
      const stageLines = chain.map((node) => {
        const stageLabel = `[${node.stage.toUpperCase()}]`.padEnd(14, " ");
        const loc = node.file ? ` (${node.file}${node.line ? `:${node.line}` : ""})` : "";
        return `${stageLabel} ${node.symbol}${loc}`;
      });
      message = `=== VERTICAL SLICE TRACE (${confidence.toUpperCase()}) ===\n` + stageLines.join("\n");
    }

    return {
      query,
      found: true,
      confidence,
      is_exact_match: confidence === "exact",
      architecture_style: record.architecture_style,
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
