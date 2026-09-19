import { describe, expect, it } from "bun:test";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";

describe("ModuleResolver", () => {
  const mockConfig: ValidatedSeptumConfig = {
    version: "1.0",
    settings: {
      enforcement: "strict",
      db_path: ":memory:",
      ignore_patterns: [],
    },
    domains: {
      billing: {
        root: "src/domains/billing",
        description: "Billing domain",
        allowed_dependencies: ["identity"],
        forbidden_dependencies: ["orders"],
        archetypes: {},
      },
      orders: {
        root: "src/domains/orders",
        description: "Orders domain",
        allowed_dependencies: ["billing"],
        forbidden_dependencies: ["identity"],
        archetypes: {},
      },
      identity: {
        root: "src/domains/identity",
        description: "Identity domain",
        allowed_dependencies: [],
        forbidden_dependencies: [],
        archetypes: {},
      },
    },
    features: {},
  };

  const resolver = new ModuleResolver(process.cwd());

  describe("resolveSourceDomain", () => {
    it("should resolve source domain from relative path", () => {
      const domain = resolver.resolveSourceDomain(
        "src/domains/billing/services/PaymentService.ts",
        mockConfig
      );
      expect(domain).toBe("billing");
    });

    it("should resolve source domain from path with leading dot-slash", () => {
      const domain = resolver.resolveSourceDomain(
        "./src/domains/orders/controllers/OrderController.ts",
        mockConfig
      );
      expect(domain).toBe("orders");
    });

    it("should return null for files outside any declared domain", () => {
      const domain = resolver.resolveSourceDomain(
        "src/shared/utils/formatters.ts",
        mockConfig
      );
      expect(domain).toBeNull();
    });
  });

  describe("resolveTargetDomain", () => {
    it("should resolve relative import from one domain to another", () => {
      const target = resolver.resolveTargetDomain(
        "../billing/services/InvoiceService",
        "src/domains/orders/OrderProcessor.ts",
        mockConfig
      );
      expect(target).toBe("billing");
    });

    it("should resolve relative import within the same domain", () => {
      const target = resolver.resolveTargetDomain(
        "./services/InvoiceService",
        "src/domains/billing/BillingController.ts",
        mockConfig
      );
      expect(target).toBe("billing");
    });

    it("should resolve target from direct domain root path", () => {
      const target = resolver.resolveTargetDomain(
        "src/domains/identity/User",
        undefined,
        mockConfig
      );
      expect(target).toBe("identity");
    });

    it("should return null for third-party libraries", () => {
      const target = resolver.resolveTargetDomain("zod", undefined, mockConfig);
      expect(target).toBeNull();
    });
  });
});
