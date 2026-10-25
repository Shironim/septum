import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TopologyDetector } from "../../src/core/discovery/topology-detector.ts";
import { DEFAULT_IGNORED_DIRECTORIES, isIgnoredDirectory, shouldIgnoreSourcePath } from "../../src/core/resources/ignore.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { IngestionPipeline } from "../../src/core/ingestion/pipeline.ts";

describe("Domain Detection & Ignore Standardization", () => {
  describe("1. Ignore Engine SSOT", () => {
    it("should ignore all standard non-source, build, and virtual environment directories (visible and hidden)", () => {
      const ignoredSamples = [
        "node_modules",
        "vendor",
        "dist",
        "build",
        "out",
        "output",
        ".output",
        "target",
        "obj",
        "bin",
        "scripts",
        "coverage",
        ".nyc_output",
        "venv",
        ".venv",
        "env",
        ".env",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".tox",
        ".next",
        ".nuxt",
        ".turbo",
        ".git",
        ".github",
        ".gitlab",
        ".septum",
        ".strata",
        ".codegraph",
        ".system_generated",
        ".gemini",
        ".claude",
        ".agents",
        ".cursor",
        ".vscode",
        ".idea",
        ".codex-evidence",
        ".antigravity",
        ".cline",
        ".roo",
        ".windsurf",
        ".cache",
        "tmp",
        "temp",
      ];

      for (const dir of ignoredSamples) {
        expect(DEFAULT_IGNORED_DIRECTORIES.has(dir)).toBe(true);
        expect(isIgnoredDirectory(dir)).toBe(true);
        expect(shouldIgnoreSourcePath(`${dir}/some-file.ts`)).toBe(true);
        expect(shouldIgnoreSourcePath(`packages/app/${dir}/nested/file.js`)).toBe(true);
      }
    });

    it("should automatically ignore ANY arbitrary hidden directory or dotfile as non-code/agent metadata", () => {
      const arbitraryDotPaths = [
        ".custom-agent/prompt.ts",
        ".roo/commands/do.js",
        ".cline/rules/rule.ts",
        ".codex-evidence/snapshot.ts",
        "deep/path/.hidden-dir/secret.ts",
        ".DS_Store",
      ];

      for (const p of arbitraryDotPaths) {
        expect(shouldIgnoreSourcePath(p)).toBe(true);
      }
    });

    it("should allow valid source paths and multi-nested source files", () => {
      const allowedPaths = [
        "src/core/parser/tree-sitter.ts",
        "src/modules/billing/domain/services/invoice.service.ts",
        "app/Http/Controllers/OrderController.php",
        "internal/auth/handler.go",
        "src/index.ts",
        "src/version.ts",
      ];

      for (const p of allowedPaths) {
        expect(shouldIgnoreSourcePath(p)).toBe(false);
      }
    });
  });

  describe("2. Standard Code Folder Anchor & Multi-Nested Domain Detection", () => {
    it("should discover layers in src/ and bind root-level files to root domain without orphaning", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-domain-test-"));

      try {
        // Setup standard src/ layout with subdirectories AND root-level files
        fs.mkdirSync(path.join(tmpDir, "src", "core"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "src", "cli"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "src", "types"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "node_modules", "dummy"), { recursive: true });

        fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "export * from './core';\n");
        fs.writeFileSync(path.join(tmpDir, "src", "version.ts"), "export const VERSION = '1.0.0';\n");
        fs.writeFileSync(path.join(tmpDir, "src", "core", "index.ts"), "export const core = 1;\n");
        fs.writeFileSync(path.join(tmpDir, "src", "cli", "index.ts"), "export const cli = 1;\n");
        fs.writeFileSync(path.join(tmpDir, "src", "types", "index.ts"), "export type T = string;\n");
        fs.writeFileSync(path.join(tmpDir, "dist", "index.js"), "compiled;\n");
        fs.writeFileSync(path.join(tmpDir, "node_modules", "dummy", "index.js"), "ignored;\n");

        const topology = TopologyDetector.detect(tmpDir);

        // Core layers discovered
        expect(topology.domains.core).toBeDefined();
        expect(topology.domains.core.root).toBe(path.join("src", "core"));
        expect(topology.domains.cli).toBeDefined();
        expect(topology.domains.cli.root).toBe(path.join("src", "cli"));
        expect(topology.domains.types).toBeDefined();

        // Root entrypoint files mapped to root domain
        expect(topology.domains.root).toBeDefined();
        expect(topology.domains.root.root).toBe("src");

        // Dist and node_modules NOT registered as domains
        expect(topology.domains.dist).toBeUndefined();
        expect(topology.domains.node_modules).toBeUndefined();

        // Verify IngestionPipeline indexes all files including root files and excludes node_modules/dist
        const dbPath = path.join(tmpDir, ".septum", "septum.db");
        const db = new SeptumDatabase(dbPath);
        const repo = new SeptumRepository(db.raw);

        TopologyDetector.discoverAndPersist(repo, tmpDir);
        const pipeline = new IngestionPipeline(repo, tmpDir);

        const config = {
          version: "1.0",
          settings: {
            enforcement: "strict" as const,
            db_path: dbPath,
            ignore_patterns: [],
          },
          domains: topology.domains,
        };

        await pipeline.run(config);

        const allFiles = repo.getAllFiles().map((f) => f.path);

        // All real source files are indexed
        expect(allFiles).toContain("src/index.ts");
        expect(allFiles).toContain("src/version.ts");
        expect(allFiles).toContain("src/core/index.ts");
        expect(allFiles).toContain("src/cli/index.ts");
        expect(allFiles).toContain("src/types/index.ts");

        // Build outputs and dependencies are NOT indexed
        expect(allFiles).not.toContain("dist/index.js");
        expect(allFiles).not.toContain("node_modules/dummy/index.js");

        // Uncovered files in repo_meta is empty of src files
        const uncoveredMeta = JSON.parse(repo.getMeta("uncovered_files") || "[]");
        const uncoveredSrc = uncoveredMeta.filter((p: string) => p.startsWith("src/"));
        expect(uncoveredSrc).toHaveLength(0);

        db.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should discover multi-nested DDD domains and ignore nested non-code folders", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-ddd-test-"));

      try {
        // Setup modular DDD: src/modules/billing and src/modules/auth with multi-nested folders
        fs.mkdirSync(path.join(tmpDir, "src", "modules", "billing", "domain", "models"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "src", "modules", "billing", "__pycache__"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "src", "modules", "auth", "services"), { recursive: true });

        fs.writeFileSync(
          path.join(tmpDir, "src", "modules", "billing", "domain", "models", "invoice.ts"),
          "export class Invoice {}\n"
        );
        fs.writeFileSync(
          path.join(tmpDir, "src", "modules", "auth", "services", "auth.service.ts"),
          "export class AuthService {}\n"
        );
        fs.writeFileSync(
          path.join(tmpDir, "src", "modules", "billing", "__pycache__", "invoice.cpython-311.pyc"),
          "binary"
        );
        fs.writeFileSync(path.join(tmpDir, "src", "main.ts"), "export const main = 1;\n");

        const topology = TopologyDetector.detect(tmpDir);

        expect(topology.architectureStyle).toBe("modular-ddd");
        expect(topology.domains.billing).toBeDefined();
        expect(topology.domains.billing.root).toBe(path.join("src", "modules", "billing"));
        expect(topology.domains.auth).toBeDefined();
        expect(topology.domains.auth.root).toBe(path.join("src", "modules", "auth"));
        expect(topology.domains.root).toBeDefined();
        expect(topology.domains.root.root).toBe("src");

        // __pycache__ must not be registered
        expect(topology.domains["__pycache__"]).toBeUndefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should discover Go clean architecture packages in internal/ and cmd/", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-go-test-"));

      try {
        fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/app\n\ngo 1.22\n");
        fs.mkdirSync(path.join(tmpDir, "internal", "auth"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "internal", "billing"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "cmd", "server"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "pkg", "util"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "target"), { recursive: true });

        fs.writeFileSync(path.join(tmpDir, "internal", "auth", "auth.go"), "package auth\n");
        fs.writeFileSync(path.join(tmpDir, "internal", "billing", "billing.go"), "package billing\n");
        fs.writeFileSync(path.join(tmpDir, "cmd", "server", "main.go"), "package main\n");
        fs.writeFileSync(path.join(tmpDir, "pkg", "util", "helper.go"), "package util\n");
        fs.writeFileSync(path.join(tmpDir, "target", "build.out"), "binary\n");

        const topology = TopologyDetector.detect(tmpDir);

        expect(topology.architectureStyle).toBe("clean-architecture");
        expect(topology.domains.auth).toBeDefined();
        expect(topology.domains.auth.root).toBe(path.join("internal", "auth"));
        expect(topology.domains.billing).toBeDefined();
        expect(topology.domains.billing.root).toBe(path.join("internal", "billing"));
        expect(topology.domains["cmd-server"]).toBeDefined();
        expect(topology.domains["cmd-server"].root).toBe(path.join("cmd", "server"));
        expect(topology.domains.pkg).toBeDefined();
        expect(topology.domains.target).toBeUndefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should explicitly map scanned_folders vs ignored_folders across frameworks including agent directories", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-folder-mapping-test-"));

      try {
        // Create code directories
        fs.mkdirSync(path.join(tmpDir, "src", "api"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "src", "services"), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, "src", "api", "handler.ts"), "export const handler = 1;\n");
        fs.writeFileSync(path.join(tmpDir, "src", "services", "svc.ts"), "export const svc = 1;\n");

        // Create ignored directories: agent harnesses, build outputs, node_modules, tests
        fs.mkdirSync(path.join(tmpDir, ".agents", "skills"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, ".gemini"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, ".codex-evidence"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "node_modules", "lib"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "dist"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, "scripts"), { recursive: true });

        fs.writeFileSync(path.join(tmpDir, ".agents", "skills", "inspect.ts"), "agent code");
        fs.writeFileSync(path.join(tmpDir, "node_modules", "lib", "index.ts"), "vendor code");
        fs.writeFileSync(path.join(tmpDir, "dist", "bundle.js"), "compiled code");

        const topology = TopologyDetector.detect(tmpDir);

        // Code folders must be in scanned_folders
        expect(topology.scanned_folders).toContain(path.join("src", "api"));
        expect(topology.scanned_folders).toContain(path.join("src", "services"));

        // Agent and dependency folders must NOT be in scanned_folders
        expect(topology.scanned_folders).not.toContain(".agents");
        expect(topology.scanned_folders).not.toContain(".gemini");
        expect(topology.scanned_folders).not.toContain("node_modules");
        expect(topology.scanned_folders).not.toContain("dist");

        // Ignored folders must record all agent & non-code folders
        expect(topology.ignored_folders).toContain(".agents");
        expect(topology.ignored_folders).toContain(".gemini");
        expect(topology.ignored_folders).toContain(".codex-evidence");
        expect(topology.ignored_folders).toContain("node_modules");
        expect(topology.ignored_folders).toContain("dist");
        expect(topology.ignored_folders).toContain("tests");
        expect(topology.ignored_folders).toContain("scripts");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("3. Dynamic SSOT Versioning from package.json", () => {
    it("should dynamically derive version constants strictly from package.json without hardcoding", async () => {
      const { SEPTUM_VERSION, SEPTUM_CURRENT_VERSION, SEPTUM_PACKAGE_NAME } = await import("../../src/utils/version-check.ts");
      const { SEPTUM_VERSION: ROOT_VERSION } = await import("../../src/version.ts");
      const packageJson = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../../package.json"), "utf-8"));

      expect(SEPTUM_VERSION).toBe(packageJson.version);
      expect(SEPTUM_CURRENT_VERSION).toBe(packageJson.version);
      expect(ROOT_VERSION).toBe(packageJson.version);
      expect(SEPTUM_PACKAGE_NAME).toBe(packageJson.name);
    });
  });
});
