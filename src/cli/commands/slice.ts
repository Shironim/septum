import { ConfigLoader } from "../../core/config/loader.ts";
import { SeptumDatabase } from "../../core/database/client.ts";
import { SeptumRepository } from "../../core/database/repository.ts";
import { VerticalSliceTracer } from "../../core/resolver/vertical-slice-tracer.ts";

export async function handleSliceCommand(
  query: string,
  options?: { json?: boolean }
): Promise<void> {
  const config = ConfigLoader.load();
  const db = new SeptumDatabase(config.settings.db_path);
  const repo = new SeptumRepository(db.raw);

  try {
    const tracer = new VerticalSliceTracer(repo);
    const result = tracer.trace(query);

    if (options?.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.found && result.slice) {
      const s = result.slice;
      console.log(`\n=================================================`);
      console.log(`  VERTICAL SLICE: ${s.route.method} ${s.route.uri}`);
      console.log(`=================================================`);
      if (s.route.name) {
        console.log(`  • Route Name:   ${s.route.name}`);
      }

      if (s.request) {
        console.log(`\n  • Request Validation:`);
        console.log(`      Class: ${s.request.class} (${s.request.file || "inline"})`);
        const rules = Object.keys(s.request.rules);
        if (rules.length > 0) {
          console.log(`      Rules:`);
          for (const r of rules) {
            console.log(`        - ${r}: ${s.request.rules[r]}`);
          }
        }
      }

      console.log(`\n  • Controller Action:`);
      console.log(`      Class:  ${s.controller.class}@${s.controller.action}`);
      console.log(`      Target: ${s.controller.file || "unknown"}:${s.controller.line}`);

      if (s.model) {
        console.log(`\n  • Model:`);
        console.log(`      Class:    ${s.model.class} (${s.model.file || "unknown"})`);
        if (s.model.fillable && s.model.fillable.length > 0) {
          console.log(`      Fillable: [${s.model.fillable.join(", ")}]`);
        }
        if (s.model.casts && Object.keys(s.model.casts).length > 0) {
          console.log(`      Casts:    ${JSON.stringify(s.model.casts)}`);
        }
      }

      if (s.frontend) {
        console.log(`\n  • Frontend Target:`);
        console.log(`      Page:  ${s.frontend.target}`);
        if (s.frontend.props.length > 0) {
          console.log(`      Props: [${s.frontend.props.join(", ")}]`);
        }
      }

      if (result.alternatives && result.alternatives.length > 0) {
        console.log(`\n  • Alternative Matches:`);
        for (const alt of result.alternatives) {
          console.log(`      - ${alt.method} ${alt.uri} -> ${alt.controller}@${alt.action}`);
        }
      }
      console.log(`\n=================================================\n`);
    } else {
      console.log(`\n❌ Vertical Slice Not Found:`);
      console.log(`   Query:   ${result.query}`);
      console.log(`   Message: ${result.message}`);

      if (result.alternatives && result.alternatives.length > 0) {
        console.log(`\n   Available Slices:`);
        for (const alt of result.alternatives) {
          console.log(`      - ${alt.method} ${alt.uri} -> ${alt.controller}@${alt.action}`);
        }
      }
      console.log(``);
    }
  } finally {
    db.close();
  }
}
