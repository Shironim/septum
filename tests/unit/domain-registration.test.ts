import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import {
  RegisterDomainSchema,
  normalizeRegisterDomainArgs,
} from "../../src/mcp/schemas.ts";
import { handleRegisterDomain } from "../../src/mcp/tools/register-domain.ts";

describe("Domain Registration & Identifier Unification", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let mockConfig: ValidatedSeptumConfig;

  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    mockConfig = {
      version: "1.0",
      settings: {
        enforcement: "strict",
        db_path: ":memory:",
        ignore_patterns: [],
      },
      domains: {},
      features: {},
    };
  });

  afterEach(() => {
    db.close();
  });

  describe("RegisterDomainSchema & Preprocessor Normalization", () => {
    it("normalizes canonical 'domain' parameter and populates 'name' symmetrically", () => {
      const parsed = RegisterDomainSchema.safeParse({
        domain: "orders",
        root: "src/domains/orders",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.domain).toBe("orders");
        expect(parsed.data.name).toBe("orders");
        expect(parsed.data.root).toBe("src/domains/orders");
      }
    });

    it("normalizes legacy 'name' parameter into canonical 'domain'", () => {
      const parsed = RegisterDomainSchema.safeParse({
        name: "billing",
        root: "src/domains/billing",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.domain).toBe("billing");
        expect(parsed.data.name).toBe("billing");
        expect(parsed.data.root).toBe("src/domains/billing");
      }
    });

    it("normalizes alias keys such as 'domain_name' and 'domainName'", () => {
      const parsed = RegisterDomainSchema.safeParse({
        domain_name: "identity",
        root_path: "src/domains/identity",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.domain).toBe("identity");
        expect(parsed.data.root).toBe("src/domains/identity");
      }
    });

    it("rejects invalid payloads missing both domain and root", () => {
      const parsed = RegisterDomainSchema.safeParse({});
      expect(parsed.success).toBe(false);
    });

    it("rejects payload with only 'root' (does not hijack root into domain)", () => {
      const parsed = RegisterDomainSchema.safeParse({
        root: "src/domains/orders",
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const domainError = parsed.error.issues.find((i) => i.path.includes("domain"));
        expect(domainError).toBeDefined();
      }
    });

    it("rejects payload with only 'root_path' or 'path'", () => {
      const parsed = RegisterDomainSchema.safeParse({
        root_path: "src/domains/orders",
      });
      expect(parsed.success).toBe(false);
    });

    it("rejects bare string without root when parsed by RegisterDomainSchema", () => {
      const parsed = RegisterDomainSchema.safeParse("orders");
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const rootError = parsed.error.issues.find((i) => i.path.includes("root"));
        expect(rootError).toBeDefined();
      }
    });

    it("normalizes bare string input into domain property via normalizeRegisterDomainArgs", () => {
      const normalized = normalizeRegisterDomainArgs("checkout") as Record<string, unknown>;
      expect(normalized.domain).toBe("checkout");
      expect(normalized.name).toBe("checkout");
    });
  });

  describe("handleRegisterDomain Tool Handler", () => {
    it("registers domain using canonical 'domain' key into SQLite SSOT and runtime config", async () => {
      const result = await handleRegisterDomain(repo, mockConfig, {
        domain: "catalog",
        root: "src/domains/catalog",
        description: "Catalog domain services",
      });

      expect(result.content[0].type).toBe("text");
      const payload = JSON.parse(result.content[0].text);

      expect(payload.status).toBe("success");
      expect(payload.domain).toBe("catalog");
      expect(payload.name).toBe("catalog");
      expect(payload.config.root).toBe("src/domains/catalog");
      expect(payload.config.description).toBe("Catalog domain services");

      expect(mockConfig.domains.catalog).toBeDefined();
      expect(repo.domains.getDomainByName("catalog")).not.toBeNull();
    });

    it("registers domain using legacy 'name' key transparently", async () => {
      const result = await handleRegisterDomain(repo, mockConfig, {
        name: "payments",
        root: "src/domains/payments",
      });

      const payload = JSON.parse(result.content[0].text);
      expect(payload.status).toBe("success");
      expect(payload.domain).toBe("payments");
      expect(payload.name).toBe("payments");
      expect(mockConfig.domains.payments).toBeDefined();
    });

    it("throws clear error when required identifier is empty", async () => {
      expect(
        handleRegisterDomain(repo, mockConfig, {
          root: "src/domains/empty",
        })
      ).rejects.toThrow("Missing required arguments");
    });
  });
});

