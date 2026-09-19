import { describe, expect, it } from "bun:test";
import { PHPExtractor } from "../../src/core/parser/extractors/php.ts";
import { PythonExtractor } from "../../src/core/parser/extractors/python.ts";
import { TypeScriptExtractor } from "../../src/core/parser/extractors/typescript.ts";

describe("Exhaustive AST Extraction", () => {
  it("should extract properties, constants, and methods in TypeScript", async () => {
    const tsCode = `
export const API_BASE_URL = "https://api.example.com";

export class OrderService {
  public readonly apiKey: string;
  private retryCount: number = 3;

  public async createOrder(cartId: string): Promise<Order> {
    return {} as any;
  }
}
`;
    const extractor = new TypeScriptExtractor();
    const ast = await extractor.extract("OrderService.ts", tsCode);

    const constSym = ast.symbols.find((s) => s.name === "API_BASE_URL");
    expect(constSym?.kind).toBe("property");

    const apiKeySym = ast.symbols.find((s) => s.name === "OrderService::apiKey");
    expect(apiKeySym?.kind).toBe("property");
    expect(apiKeySym?.visibility).toBe("public");

    const retrySym = ast.symbols.find((s) => s.name === "OrderService::retryCount");
    expect(retrySym?.kind).toBe("property");
    expect(retrySym?.visibility).toBe("private");

    const methodSym = ast.symbols.find((s) => s.name === "OrderService::createOrder");
    expect(methodSym?.kind).toBe("method");
  });

  it("should extract properties, constants, and methods in PHP", async () => {
    const phpCode = `<?php
class PaymentGateway {
    public const DEFAULT_CURRENCY = 'USD';
    private string $secretKey;
    public readonly int $timeoutSeconds;

    public function charge(int $amount): bool {
        return true;
    }
}
`;
    const extractor = new PHPExtractor();
    const ast = await extractor.extract("PaymentGateway.php", phpCode);

    const constSym = ast.symbols.find((s) => s.name === "PaymentGateway::DEFAULT_CURRENCY");
    expect(constSym?.kind).toBe("property");

    const propSym = ast.symbols.find((s) => s.name === "PaymentGateway::$secretKey");
    expect(propSym?.kind).toBe("property");
    expect(propSym?.visibility).toBe("private");

    const methodSym = ast.symbols.find((s) => s.name === "PaymentGateway::charge");
    expect(methodSym?.kind).toBe("method");
  });

  it("should extract attributes, constants, and methods in Python", async () => {
    const pyCode = `
MAX_RETRIES = 5

class OrderModel:
    order_id: str
    status: str = "pending"

    def cancel(self) -> bool:
        return True
`;
    const extractor = new PythonExtractor();
    const ast = await extractor.extract("order_model.py", pyCode);

    const constSym = ast.symbols.find((s) => s.name === "MAX_RETRIES");
    expect(constSym?.kind).toBe("property");

    const attrSym = ast.symbols.find((s) => s.name === "OrderModel::order_id");
    expect(attrSym?.kind).toBe("property");

    const methodSym = ast.symbols.find((s) => s.name === "OrderModel::cancel");
    expect(methodSym?.kind).toBe("method");
  });
});
