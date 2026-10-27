import { describe, expect, it } from "bun:test";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import { auditStagedFiles } from "../../src/core/boundary/staged-auditor.ts";
import { SeptumConfigSchema } from "../../src/core/config/schema.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { handleSymbolTool } from "../../src/mcp/tools/symbol.ts";
import { SymbolToolSchema } from "../../src/mcp/schemas.ts";
import { SessionManager } from "../../src/core/session/session-manager.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

describe("Bugfix Verifications: 4 Root Cause Fixes", () => {
  it("Bug 1: should allow disambiguating non-unique symbols in symbol impact via file_path and symbol_ref through SymbolToolSchema", async () => {
    const db = new SeptumDatabase(":memory:");
    const repo = new SeptumRepository(db.raw);

    try {
      repo.upsertDomain("core", { root: "src/core" });
      const f1Id = repo.upsertFile(1, "src/core/parser/a.ts", "source", "hash-a", 10, 100, 100);
      const f2Id = repo.upsertFile(1, "src/core/parser/b.ts", "source", "hash-b", 10, 100, 100);
      const callerId = repo.upsertFile(1, "src/core/caller.ts", "source", "hash-c", 10, 100, 100);

      repo.replaceFileSymbols(f1Id, [
        {
          name: "cleanLiteral",
          kind: "function",
          signature: "cleanLiteral(): string",
          visibility: "public",
          line_start: 1,
          line_end: 5,
        },
      ]);
      repo.replaceFileSymbols(f2Id, [
        {
          name: "cleanLiteral",
          kind: "function",
          signature: "cleanLiteral(): string",
          visibility: "public",
          line_start: 1,
          line_end: 5,
        },
      ]);

      // caller.ts only imports cleanLiteral from a.ts
      repo.replaceFileDependencies(callerId, [
        {
          target: "cleanLiteral",
          statement: 'import { cleanLiteral } from "./parser/a"',
          line_number: 1,
          is_external: false,
        },
      ]);

      const config = SeptumConfigSchema.parse({
        domains: { core: { root: "src/core" } },
      });

      // 1. Without file_path: returns ambiguous with 2 candidates
      const rawAmbiguousArgs = {
        action: "impact",
        query: "cleanLiteral",
      };
      const parsedArgs = SymbolToolSchema.parse(rawAmbiguousArgs);
      const ambiguousResult = await handleSymbolTool(repo, config, parsedArgs);
      const parsedAmbiguous = JSON.parse(ambiguousResult.content[0].text);
      expect(parsedAmbiguous.status).toBe("ambiguous");
      expect(parsedAmbiguous.candidates.length).toBe(2);

      // 2. With symbol_ref: passes SymbolToolSchema validation and isolates callers
      const candidateA = parsedAmbiguous.candidates.find((c: any) => c.file_path === "src/core/parser/a.ts");
      const candidateB = parsedAmbiguous.candidates.find((c: any) => c.file_path === "src/core/parser/b.ts");
      expect(candidateA).toBeDefined();
      expect(candidateB).toBeDefined();

      const schemaParsedWithRef = SymbolToolSchema.parse({
        action: "impact",
        symbol_ref: candidateA.symbol_ref,
      });
      const resolvedWithRefResult = await handleSymbolTool(repo, config, schemaParsedWithRef);
      const parsedRefResult = JSON.parse(resolvedWithRefResult.content[0].text);
      expect(parsedRefResult.target_symbol).toBe("cleanLiteral");
      expect(parsedRefResult.found_in_index).toBe(true);
      expect(parsedRefResult.impact_summary.total_dependents).toBe(1);
      expect(parsedRefResult.inbound_callers.length).toBe(1);
      expect(parsedRefResult.inbound_callers[0].file).toBe("src/core/caller.ts");

      // 3. Candidate B (b.ts) must have 0 callers and not leak caller from a.ts!
      const schemaParsedB = SymbolToolSchema.parse({
        action: "impact",
        symbol_ref: candidateB.symbol_ref,
      });
      const resultB = await handleSymbolTool(repo, config, schemaParsedB);
      const parsedB = JSON.parse(resultB.content[0].text);
      expect(parsedB.impact_summary.total_dependents).toBe(0);
      expect(parsedB.inbound_callers.length).toBe(0);

      // 4. Windows backslash path normalization on file_path
      const resolvedWindowsResult = await handleSymbolTool(repo, config, SymbolToolSchema.parse({
        action: "impact",
        query: "cleanLiteral",
        file_path: "src\\core\\parser\\a.ts",
      }));
      const parsedWinResult = JSON.parse(resolvedWindowsResult.content[0].text);
      expect(parsedWinResult.found_in_index).toBe(true);
      expect(parsedWinResult.impact_summary.total_dependents).toBe(1);

      // 5. Non-existent file_path early returns found_in_index: false with 0 dependents
      const nonExistentResult = await handleSymbolTool(repo, config, SymbolToolSchema.parse({
        action: "impact",
        query: "cleanLiteral",
        file_path: "src/core/parser/nonexistent.ts",
      }));
      const parsedNonExistent = JSON.parse(nonExistentResult.content[0].text);
      expect(parsedNonExistent.found_in_index).toBe(false);
      expect(parsedNonExistent.impact_summary.total_dependents).toBe(0);
      expect(parsedNonExistent.inbound_callers.length).toBe(0);
    } finally {
      db.close();
    }
  });

  it("Bug 2: checkFeatureTouchpoints supports wildcard globs (*.ts, **, etc.)", () => {
    const db = new SeptumDatabase(":memory:");
    const repo = new SeptumRepository(db.raw);

    try {
      const config = SeptumConfigSchema.parse({
        domains: { core: { root: "src/core" } },
        features: {
          test_glob: {
            domain: "core",
            description: "Test glob patterns",
            allowed_touchpoints: ["src/core/*.ts", "src/core/sub/**/*.ts"],
          },
        },
      });

      const evaluator = new BoundaryEvaluator(repo);

      // Matches direct *.ts pattern
      const v1 = evaluator.checkFeatureTouchpoints("test_glob", "src/core/utils.ts", config);
      expect(v1.length).toBe(0);

      // Matches nested **/*.ts pattern
      const v2 = evaluator.checkFeatureTouchpoints("test_glob", "src/core/sub/nested/file.ts", config);
      expect(v2.length).toBe(0);

      // Rejects non-matching extension or path
      const v3 = evaluator.checkFeatureTouchpoints("test_glob", "src/core/utils.py", config);
      expect(v3.length).toBe(1);
      expect(v3[0].rule).toBe("touchpoint_violation");
    } finally {
      db.close();
    }
  });

  it("Bug 3: SessionManager detects dead process locks and clears orphaned sessions cleanly", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "septum-session-test-"));
    try {
      const septumDir = join(tempDir, ".septum");
      mkdirSync(septumDir, { recursive: true });

      // An impossibly high PID or known dead PID
      const deadPid = 999999999;
      expect(SessionManager.isOwnerAlive(`process:${deadPid}`)).toBe(false);

      // Write session with dead owner
      writeFileSync(
        join(septumDir, "session.json"),
        JSON.stringify({
          feature_key: "orphan_feature",
          domain: "core",
          touchpoints: ["src/core/**"],
          locked_at: new Date().toISOString(),
          owner_id: `process:${deadPid}`,
        })
      );

      // Attempt to clear without force from a different process
      const currentPid = `process:${process.pid}`;
      expect(SessionManager.clearActiveSession(tempDir, currentPid, false)).toBe(true);

      // Confirm session is cleared
      expect(SessionManager.getActiveSession(tempDir)).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("Bug 4: auditStagedFiles normalizes Windows-style prefix vs git posix output", async () => {
    const parent = mkdtempSync(join(tmpdir(), "septum-staged-win-"));
    const workspace = join(parent, "apps", "backend");
    const db = new SeptumDatabase(":memory:");
    const repo = new SeptumRepository(db.raw);

    try {
      mkdirSync(join(workspace, "src"), { recursive: true });
      mkdirSync(join(parent, "sibling"), { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: parent });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: parent });
      execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: parent });

      writeFileSync(join(workspace, "src/index.ts"), "export const x = 1;\n");
      writeFileSync(join(parent, "sibling/other.ts"), "export const y = 2;\n");
      execFileSync("git", ["add", "."], { cwd: parent });

      repo.upsertDomain("backend", { root: "src" });
      const config = SeptumConfigSchema.parse({
        domains: { backend: { root: "src" } },
      });
      const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(workspace, repo));

      // Running auditStagedFiles from the nested subfolder
      const result = await auditStagedFiles(evaluator, config, workspace, undefined, repo);
      expect(result.files).toEqual(["src/index.ts"]);
      expect(result.violations.length).toBe(0);
    } finally {
      db.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
