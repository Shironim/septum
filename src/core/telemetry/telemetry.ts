import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SeptumToolCallEvent {
  timestamp?: string;
  event: "tool_call_completed" | "tool_call_failed";
  tool: string;
  duration_ms: number;
  input: Record<string, any>;
  metrics?: {
    bytes_out?: number;
    lines_out?: number;
    nodes_returned?: number;
  };
  session?: {
    feature_key?: string | null;
    domain?: string | null;
  } | null;
  status: "success" | "error";
  error?: {
    code?: string;
    message: string;
    stack?: string;
  };
}

export class SeptumTelemetry {
  private static readonly MAX_LOG_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
  private static readonly SLOW_EXECUTION_THRESHOLD_MS = 250;

  /**
   * Resolves the log file path inside the active workspace's .septum directory.
   */
  public static getLogPath(workspaceRoot: string = process.cwd()): string {
    return join(workspaceRoot, ".septum", "septum.log");
  }

  /**
   * Records a tool call event to both stderr (dual-sink) and .septum/septum.log.
   */
  public static recordToolCall(
    event: SeptumToolCallEvent,
    workspaceRoot: string = process.cwd()
  ): void {
    const payload: SeptumToolCallEvent = {
      timestamp: event.timestamp || new Date().toISOString(),
      ...event,
    };

    const jsonLine = JSON.stringify(payload);

    // Sink 1: Live stderr stream for operator monitoring (slow queries & failures)
    if (payload.status === "error") {
      console.error(`[Septum Telemetry ERROR] ${jsonLine}`);
    } else if (payload.duration_ms >= this.SLOW_EXECUTION_THRESHOLD_MS) {
      console.error(`[Septum Telemetry SLOW_WARN] ${jsonLine}`);
    }

    this.appendLog(jsonLine, workspaceRoot);
  }

  public static recordMemorySample(metrics: Record<string, number>, workspaceRoot: string = process.cwd()): void {
    const jsonLine = JSON.stringify({timestamp: new Date().toISOString(), event: "memory_sample", metrics});
    console.error(`[Septum Memory] ${jsonLine}`);
    this.appendLog(jsonLine, workspaceRoot);
  }

  private static appendLog(jsonLine: string, workspaceRoot: string): void {
    // Sink 2: Append-only persistent file recorder in .septum/septum.log
    try {
      const logPath = this.getLogPath(workspaceRoot);
      const logDir = dirname(logPath);

      // SV-03: Do not auto-scaffold .septum directory for telemetry if workspace has not been initialized
      if (!existsSync(logDir)) {
        return;
      }

      // Check for rotation if file exceeds 2MB
      if (existsSync(logPath)) {
        try {
          const stats = statSync(logPath);
          if (stats.size >= this.MAX_LOG_SIZE_BYTES) {
            const rotatedPath = `${logPath}.1`;
            renameSync(logPath, rotatedPath);
          }
        } catch {
          // If stat/rotation fails, proceed to append without crashing
        }
      }

      appendFileSync(logPath, `${jsonLine}\n`, "utf8");
    } catch {
      // Telemetry file writes must never crash the main application process
    }
  }
}
