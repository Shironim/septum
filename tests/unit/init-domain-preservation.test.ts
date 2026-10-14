import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { TopologyDetector } from "../../src/core/discovery/topology-detector.ts";
import { EnvironmentDetector } from "../../src/core/topology/environment-detector.ts";

describe("F2-02: Domain Registration & Topology Preservation on Repeat Init", () => {
  it("should preserve manual domain root, dependencies, and archetypes on repeat init", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-domain-preserve-"));
    const dbPath = path.join(tmpDir, ".septum", "septum.db");

    try {
      // 1. Setup a project fixture with src/core, src/cli, src/types
      fs.mkdirSync(path.join(tmpDir, "src", "core"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "src", "cli"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "src", "types"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src", "core", "index.ts"), "export const core = 1;\n");
      fs.writeFileSync(path.join(tmpDir, "src", "cli", "index.ts"), "export const cli = 1;\n");
      fs.writeFileSync(path.join(tmpDir, "src", "types", "index.ts"), "export const types = 1;\n");
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "fixture-preserve", version: "1.0.0" })
      );

      // 2. Initial DB setup with custom domain policy
      const db = new SeptumDatabase(dbPath);
      const repo = new SeptumRepository(db.raw);

      repo.upsertDomain("core", {
        root: "manual/core",
        allowed_dependencies: ["billing"],
        forbidden_dependencies: ["orders"],
        archetypes: { widget: "*.ts" },
      });
      repo.upsertDomain("user-domain", {
        root: "manual/core",
        allowed_dependencies: ["billing"],
      });
      repo.setMeta("settings_json", JSON.stringify({ enforcement: "strict" }));
      repo.setMeta(
        "features_json",
        JSON.stringify({ userFeature: { domain: "core", allowed_touchpoints: ["manual/core/value.ts"] } })
      );
      repo.environment.saveLayer({
        layer: "host",
        platform: "User VPS",
        status: "VERIFIED",
        constraints: ["USER_CONSTRAINT"],
        detected_from: ["manual"],
      });

      // 3. Run repeat init discovery (force = false)
      const domains = TopologyDetector.discoverAndPersist(repo, tmpDir, false);
      EnvironmentDetector.detect(tmpDir, repo, false);

      // 4. Verify that manual core domain properties are preserved
      const coreRecord = repo.domains.getDomainByName("core");
      expect(coreRecord).toBeDefined();
      expect(coreRecord?.root_path).toBe("manual/core");
      expect(JSON.parse(coreRecord?.allowed_deps_json || "[]")).toEqual(["billing"]);
      expect(JSON.parse(coreRecord?.forbidden_deps_json || "[]")).toEqual(["orders"]);
      expect(JSON.parse(coreRecord?.archetypes_json || "{}")).toEqual({ widget: "*.ts" });

      // 5. Verify that user-domain is preserved
      const userDomainRecord = repo.domains.getDomainByName("user-domain");
      expect(userDomainRecord).toBeDefined();
      expect(userDomainRecord?.root_path).toBe("manual/core");

      // 6. Verify that new domains (cli, types) were discovered and added
      const cliRecord = repo.domains.getDomainByName("cli");
      const typesRecord = repo.domains.getDomainByName("types");
      expect(cliRecord).toBeDefined();
      expect(cliRecord?.root_path).toBe(path.join("src", "cli"));
      expect(typesRecord).toBeDefined();
      expect(typesRecord?.root_path).toBe(path.join("src", "types"));

      // 7. Verify settings, features, and VERIFIED host environment survived
      const settings = repo.getMeta("settings_json");
      expect(settings).toBe(JSON.stringify({ enforcement: "strict" }));

      const features = repo.getMeta("features_json");
      expect(features).toContain("userFeature");

      const hostLayer = repo.environment.getLayer("host");
      expect(hostLayer?.status).toBe("VERIFIED");
      expect(hostLayer?.platform).toBe("User VPS");

      // 8. Verify the returned domains map reflects existing preserved roots
      expect(domains["core"]?.root).toBe("manual/core");
      expect(domains["user-domain"]?.root).toBe("manual/core");
      expect(domains["cli"]?.root).toBe(path.join("src", "cli"));

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should reset policies when forceResetPolicies is explicitly true", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-domain-force-"));
    const dbPath = path.join(tmpDir, ".septum", "septum.db");

    try {
      fs.mkdirSync(path.join(tmpDir, "src", "core"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "src", "core", "index.ts"), "export const core = 1;\n");
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "fixture-force", version: "1.0.0" })
      );

      const db = new SeptumDatabase(dbPath);
      const repo = new SeptumRepository(db.raw);

      repo.upsertDomain("core", {
        root: "manual/core",
        allowed_dependencies: ["billing"],
      });

      // Run with forceResetPolicies = true
      TopologyDetector.discoverAndPersist(repo, tmpDir, true);

      const coreRecord = repo.domains.getDomainByName("core");
      expect(coreRecord).toBeDefined();
      expect(coreRecord?.root_path).toBe(path.join("src", "core"));

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
