import { describe, expect, it } from "bun:test";
import { BoundaryEvaluator } from "../../src/core/boundary/evaluator.ts";
import type { ValidatedSeptumConfig } from "../../src/core/config/schema.ts";
import { SeptumDatabase } from "../../src/core/database/client.ts";
import { SeptumRepository } from "../../src/core/database/repository.ts";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";

describe("Septum 3-Gate Active Hook Verification", () => {
  const db = new SeptumDatabase(":memory:");
  const repo = new SeptumRepository(db.raw);
  const evaluator = new BoundaryEvaluator(repo);
  const astEngine = new ASTParserEngine();

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
    features: {
      cancel_order_flow: {
        domain: "orders",
        description: "Order cancellation flow",
        allowed_touchpoints: [
          "src/domains/orders/controllers/CancelOrderController.ts",
          "src/domains/orders/services/OrderCancellationService.ts",
        ],
        reuse_symbols: ["PaymentService"],
        input_contract: { order_id: "string" },
        output_contract: { cancelled: "boolean" },
      },
    },
  };

  it("Gate 1: should block target files outside allowed_touchpoints", () => {
    // Attempting to edit an unauthorized file under the active feature
    const violations = evaluator.checkFeatureTouchpoints(
      "cancel_order_flow",
      "src/domains/orders/controllers/UnrelatedController.ts",
      mockConfig
    );

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe("touchpoint_violation");
    expect(violations[0].message).toContain("outside the declared allowed_touchpoints");
  });

  it("Gate 1: should permit target files declared in allowed_touchpoints", () => {
    const violations = evaluator.checkFeatureTouchpoints(
      "cancel_order_flow",
      "src/domains/orders/controllers/CancelOrderController.ts",
      mockConfig
    );

    expect(violations.length).toBe(0);
  });

  it("Gate 2: should block forbidden cross-domain imports in proposed code", async () => {
    const proposedCode = `
import { OrderProcessor } from "../../orders/processor";
export class PaymentService {
  public pay() {}
}
`;
    const parsed = await astEngine.parseFile(
      "src/domains/billing/services/PaymentService.ts",
      proposedCode
    );
    const proposedImports = parsed.dependencies.map((d) => d.target);

    const violations = evaluator.checkProposedChanges(
      "src/domains/billing/services/PaymentService.ts",
      proposedImports,
      mockConfig
    );

    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe("forbidden_dependency");
    expect(violations[0].source_domain).toBe("billing");
    expect(violations[0].target_domain).toBe("orders");
  });

  it("Gate 2: should permit approved cross-domain imports", async () => {
    const proposedCode = `
import { User } from "../../identity/user";
export class PaymentService {
  public pay() {}
}
`;
    const parsed = await astEngine.parseFile(
      "src/domains/billing/services/PaymentService.ts",
      proposedCode
    );
    const proposedImports = parsed.dependencies.map((d) => d.target);

    const violations = evaluator.checkProposedChanges(
      "src/domains/billing/services/PaymentService.ts",
      proposedImports,
      mockConfig
    );

    expect(violations.length).toBe(0);
  });

  it("Gate 3: should identify whether a source domain was properly resolved for consultation check", () => {
    const domain = evaluator.resolveSourceDomain(
      "src/domains/billing/services/PaymentService.ts",
      mockConfig
    );
    expect(domain).toBe("billing");
  });
});
