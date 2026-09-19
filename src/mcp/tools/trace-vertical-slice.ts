import type { ValidatedSeptumConfig } from "../../core/config/schema.ts";
import type { SeptumRepository } from "../../core/database/repository.ts";
import { VerticalSliceTracer } from "../../core/resolver/vertical-slice-tracer.ts";
import type { VerticalSliceTraceResponse } from "../../types/index.ts";

export interface TraceVerticalSliceArgs {
  query: string;
}

export function handleTraceVerticalSlice(
  repo: SeptumRepository,
  config: ValidatedSeptumConfig,
  args: TraceVerticalSliceArgs
) {
  if (!args.query) {
    throw new Error(
      "Missing required argument: 'query' (e.g. 'POST /orders/{id}/status', 'OrderController@updateStatus', or task intent 'Ubah status order di dashboard')"
    );
  }

  const tracer = new VerticalSliceTracer(repo);
  const result: VerticalSliceTraceResponse = tracer.trace(args.query);

  let formattedText = "";

  if (result.found && result.slice) {
    const s = result.slice;
    formattedText = `=== VERTICAL SLICE TRACE ===\n`;
    formattedText += `Query: ${result.query}\n`;
    formattedText += `Status: RESOLVED\n\n`;

    formattedText += `• Route:\n`;
    formattedText += `    Method: ${s.route.method}\n`;
    formattedText += `    URI:    ${s.route.uri}\n`;
    if (s.route.name) {
      formattedText += `    Name:   ${s.route.name}\n`;
    }

    if (s.request) {
      formattedText += `\n• Request / Validation:\n`;
      formattedText += `    Class:  ${s.request.class} (${s.request.file || "inline"})\n`;
      const ruleKeys = Object.keys(s.request.rules);
      if (ruleKeys.length > 0) {
        formattedText += `    Rules:\n`;
        for (const k of ruleKeys) {
          formattedText += `      - ${k} => ${s.request.rules[k]}\n`;
        }
      }
    }

    formattedText += `\n• Controller Action:\n`;
    formattedText += `    Class:  ${s.controller.class}@${s.controller.action}\n`;
    formattedText += `    File:   ${s.controller.file || "unknown"}:${s.controller.line}\n`;

    if (s.model) {
      formattedText += `\n• Model:\n`;
      formattedText += `    Class:  ${s.model.class} (${s.model.file || "unknown"})\n`;
      if (s.model.fillable && s.model.fillable.length > 0) {
        formattedText += `    Fillable: [${s.model.fillable.join(", ")}]\n`;
      }
      if (s.model.casts && Object.keys(s.model.casts).length > 0) {
        formattedText += `    Casts:    ${JSON.stringify(s.model.casts)}\n`;
      }
    }

    if (s.frontend) {
      formattedText += `\n• Frontend Target:\n`;
      formattedText += `    Page:   ${s.frontend.target}\n`;
      if (s.frontend.props.length > 0) {
        formattedText += `    Props:  [${s.frontend.props.join(", ")}]\n`;
      }
    }

    if (result.alternatives && result.alternatives.length > 0) {
      formattedText += `\n• Other Matching Slices:\n`;
      for (const alt of result.alternatives) {
        formattedText += `    - ${alt.method} ${alt.uri} -> ${alt.controller}@${alt.action}\n`;
      }
    }
  } else {
    formattedText = `=== VERTICAL SLICE NOT FOUND ===\n`;
    formattedText += `Query: ${result.query}\n`;
    formattedText += `Message: ${result.message}\n`;

    if (result.alternatives && result.alternatives.length > 0) {
      formattedText += `\nAvailable Slices:\n`;
      for (const alt of result.alternatives) {
        formattedText += `    - ${alt.method} ${alt.uri} -> ${alt.controller}@${alt.action}\n`;
      }
    }
  }

  return {
    content: [
      {
        type: "text",
        text: formattedText.trim(),
      },
    ],
    metadata: result,
  };
}
