import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SeptumTelemetry } from "../src/core/telemetry/telemetry.ts";

describe("SeptumTelemetry Engine", () => {
  const testDir = join(import.meta.dir, "temp-telemetry-test");
  const logFile = join(testDir, ".septum", "septum.log");

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("records tool call completions into .septum/septum.log as JSON Lines", () => {
    SeptumTelemetry.recordToolCall(
      {
        event: "tool_call_completed",
        tool: "septum_get_domain_catalog",
        duration_ms: 22,
        input: { domain: "orders" },
        metrics: { bytes_out: 480, lines_out: 18, nodes_returned: 6 },
        session: { feature_key: "checkout-v2", domain: "orders" },
        status: "success",
      },
      testDir
    );

    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf8").trim();
    const parsed = JSON.parse(content);

    expect(parsed.event).toBe("tool_call_completed");
    expect(parsed.tool).toBe("septum_get_domain_catalog");
    expect(parsed.duration_ms).toBe(22);
    expect(parsed.metrics.bytes_out).toBe(480);
    expect(parsed.session.feature_key).toBe("checkout-v2");
    expect(parsed.status).toBe("success");
  });

  it("records tool call failures with diagnostic metadata", () => {
    SeptumTelemetry.recordToolCall(
      {
        event: "tool_call_failed",
        tool: "septum_trace_vertical_slice",
        duration_ms: 10,
        input: { query: "POST /missing" },
        status: "error",
        error: { code: "NOT_FOUND", message: "Route not registered" },
      },
      testDir
    );

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);

    expect(last.event).toBe("tool_call_failed");
    expect(last.status).toBe("error");
    expect(last.error.message).toBe("Route not registered");
  });

  it("rotates log file when size reaches 2MB threshold", () => {
    const bigData = "Y".repeat(2 * 1024 * 1024);
    SeptumTelemetry.recordToolCall(
      { event: "tool_call_completed", tool: "init", duration_ms: 1, input: {}, status: "success" },
      testDir
    );
    writeFileSync(logFile, bigData, "utf8");

    // Trigger next write after 2MB
    SeptumTelemetry.recordToolCall(
      { event: "tool_call_completed", tool: "after_rotation", duration_ms: 2, input: {}, status: "success" },
      testDir
    );

    const rotatedFile = `${logFile}.1`;
    expect(existsSync(rotatedFile)).toBe(true);
    expect(existsSync(logFile)).toBe(true);
  });
});
