import { describe, expect, it } from "bun:test";
import { findBraceBlockEnd, findPythonBlockEnd } from "../../src/core/parser/boundary-tracker.ts";
import { GoExtractor } from "../../src/core/parser/extractors/go.ts";
import { PHPExtractor } from "../../src/core/parser/extractors/php.ts";
import { PythonExtractor } from "../../src/core/parser/extractors/python.ts";
import { TypeScriptExtractor } from "../../src/core/parser/extractors/typescript.ts";

describe("Boundary Tracker - findBraceBlockEnd", () => {
  it("should accurately determine boundaries for a multi-line function", () => {
    const code = [
      "function calculateTotal(items: number[]): number {", // line 1 (idx 0)
      "  let total = 0;",                                  // line 2 (idx 1)
      "  for (const item of items) {",                     // line 3 (idx 2)
      "    total += item;",                                // line 4 (idx 3)
      "  }",                                               // line 5 (idx 4)
      "  return total;",                                   // line 6 (idx 5)
      "}",                                                 // line 7 (idx 6)
      "",                                                  // line 8 (idx 7)
    ];

    const endLine = findBraceBlockEnd(code, 0);
    expect(endLine).toBe(7);
  });

  it("should ignore braces inside single quotes, double quotes, and template literals", () => {
    const code = [
      "function renderTemplate(): string {",               // line 1 (idx 0)
      "  const a = '{not a real block}';",                 // line 2 (idx 1)
      "  const b = \"{also not a block}\";",               // line 3 (idx 2)
      "  const c = `{nested ${'{fake}'}}`;",               // line 4 (idx 3)
      "  return a + b + c;",                               // line 5 (idx 4)
      "}",                                                 // line 6 (idx 5)
    ];

    const endLine = findBraceBlockEnd(code, 0);
    expect(endLine).toBe(6);
  });

  it("should ignore braces inside comments", () => {
    const code = [
      "function doWork(): void {",                         // line 1 (idx 0)
      "  // { this comment should be ignored",             // line 2 (idx 1)
      "  /*",                                              // line 3 (idx 2)
      "     } this multi-line comment should be ignored",  // line 4 (idx 3)
      "  */",                                              // line 5 (idx 4)
      "  console.log('done');",                            // line 6 (idx 5)
      "}",                                                 // line 7 (idx 6)
    ];

    const endLine = findBraceBlockEnd(code, 0);
    expect(endLine).toBe(7);
  });
});

describe("Boundary Tracker - findPythonBlockEnd", () => {
  it("should accurately determine indentation boundaries for Python functions", () => {
    const code = [
      "def process_data(data):",      // line 1 (idx 0)
      "    total = 0",                // line 2 (idx 1)
      "    for item in data:",        // line 3 (idx 2)
      "        total += item",        // line 4 (idx 3)
      "    return total",             // line 5 (idx 4)
      "",                             // line 6 (idx 5)
      "def next_function():",         // line 7 (idx 6)
      "    pass",                     // line 8 (idx 7)
    ];

    const endLine = findPythonBlockEnd(code, 0);
    expect(endLine).toBe(5);
  });
});

describe("TypeScriptExtractor - Line Count & Hotspot Metrics", () => {
  it("should calculate correct line_start, line_end, and line_count for functions and classes", async () => {
    const code = `
export class OrderService {
  public validate(orderId: string): boolean {
    if (!orderId) {
      return false;
    }
    return true;
  }

  public processOrder(orderId: string): void {
    const isValid = this.validate(orderId);
    if (!isValid) {
      throw new Error("Invalid order");
    }
    console.log("Order processed");
  }
}

export function helperFunction(): string {
  const message = "hello";
  return message;
}
`.trim();

    const extractor = new TypeScriptExtractor();
    const result = await extractor.extract("OrderService.ts", code);

    const symbols = result.symbols;

    const classSymbol = symbols.find((s) => s.name === "OrderService" && s.kind === "class");
    expect(classSymbol).toBeDefined();
    expect(classSymbol!.line_start).toBe(1);
    expect(classSymbol!.line_end).toBe(16);
    expect(classSymbol!.line_count).toBe(16);

    const validateMethod = symbols.find((s) => s.name.endsWith("validate"));
    expect(validateMethod).toBeDefined();
    expect(validateMethod!.line_start).toBe(2);
    expect(validateMethod!.line_end).toBe(7);
    expect(validateMethod!.line_count).toBe(6);

    const processMethod = symbols.find((s) => s.name.endsWith("processOrder"));
    expect(processMethod).toBeDefined();
    expect(processMethod!.line_start).toBe(9);
    expect(processMethod!.line_end).toBe(15);
    expect(processMethod!.line_count).toBe(7);

    const helper = symbols.find((s) => s.name === "helperFunction");
    expect(helper).toBeDefined();
    expect(helper!.line_start).toBe(18);
    expect(helper!.line_end).toBe(21);
    expect(helper!.line_count).toBe(4);
  });
});

describe("PythonExtractor - Line Count & Hotspot Metrics", () => {
  it("should calculate correct line_start, line_end, and line_count for Python class and functions", async () => {
    const code = `
class UserService:
    def __init__(self, db):
        self.db = db

    def get_user(self, user_id: int):
        if not user_id:
            return None
        return self.db.find(user_id)

def standalone_helper(x: int) -> int:
    result = x * 2
    return result
`.trim();

    const extractor = new PythonExtractor();
    const result = await extractor.extract("user_service.py", code);

    const classSymbol = result.symbols.find((s) => s.name === "UserService" && s.kind === "class");
    expect(classSymbol).toBeDefined();
    expect(classSymbol!.line_start).toBe(1);
    expect(classSymbol!.line_end).toBe(8);
    expect(classSymbol!.line_count).toBe(8);

    const initMethod = result.symbols.find((s) => s.name.endsWith("__init__"));
    expect(initMethod).toBeDefined();
    expect(initMethod!.line_start).toBe(2);
    expect(initMethod!.line_end).toBe(3);
    expect(initMethod!.line_count).toBe(2);

    const getUserMethod = result.symbols.find((s) => s.name.endsWith("get_user"));
    expect(getUserMethod).toBeDefined();
    expect(getUserMethod!.line_start).toBe(5);
    expect(getUserMethod!.line_end).toBe(8);
    expect(getUserMethod!.line_count).toBe(4);

    const helper = result.symbols.find((s) => s.name === "standalone_helper");
    expect(helper).toBeDefined();
    expect(helper!.line_start).toBe(10);
    expect(helper!.line_end).toBe(12);
    expect(helper!.line_count).toBe(3);
  });
});

describe("GoExtractor - Line Count & Hotspot Metrics", () => {
  it("should calculate correct line_start, line_end, and line_count for Go structs, methods, and functions", async () => {
    const code = `
package service

type OrderRepo struct {
    db DB
}

func (r *OrderRepo) FindOrder(id string) (*Order, error) {
    if id == "" {
        return nil, errors.New("empty id")
    }
    return r.db.Get(id)
}

func ValidateOrder(id string) bool {
    return len(id) > 0
}
`.trim();

    const extractor = new GoExtractor();
    const result = await extractor.extract("order_service.go", code);

    const structSymbol = result.symbols.find((s) => s.name === "OrderRepo");
    expect(structSymbol).toBeDefined();
    expect(structSymbol!.line_start).toBe(3);
    expect(structSymbol!.line_end).toBe(5);
    expect(structSymbol!.line_count).toBe(3);

    const methodSymbol = result.symbols.find((s) => s.name === "FindOrder" && s.kind === "method");
    expect(methodSymbol).toBeDefined();
    expect(methodSymbol!.line_start).toBe(7);
    expect(methodSymbol!.line_end).toBe(12);
    expect(methodSymbol!.line_count).toBe(6);

    const funcSymbol = result.symbols.find((s) => s.name === "ValidateOrder" && s.kind === "function");
    expect(funcSymbol).toBeDefined();
    expect(funcSymbol!.line_start).toBe(14);
    expect(funcSymbol!.line_end).toBe(16);
    expect(funcSymbol!.line_count).toBe(3);
  });
});

describe("PHPExtractor - Line Count & Hotspot Metrics", () => {
  it("should calculate correct line_start, line_end, and line_count for PHP classes, methods, and functions", async () => {
    const code = `<?php

class PaymentGateway {
    public function charge(float $amount): bool {
        if ($amount <= 0) {
            return false;
        }
        return true;
    }
}

function formatCurrency(float $val): string {
    return '$' . number_format($val, 2);
}
`;

    const extractor = new PHPExtractor();
    const result = await extractor.extract("PaymentGateway.php", code);

    const classSymbol = result.symbols.find((s) => s.name === "PaymentGateway" && s.kind === "class");
    expect(classSymbol).toBeDefined();
    expect(classSymbol!.line_start).toBe(3);
    expect(classSymbol!.line_end).toBe(10);
    expect(classSymbol!.line_count).toBe(8);

    const methodSymbol = result.symbols.find((s) => s.name.endsWith("charge"));
    expect(methodSymbol).toBeDefined();
    expect(methodSymbol!.line_start).toBe(4);
    expect(methodSymbol!.line_end).toBe(9);
    expect(methodSymbol!.line_count).toBe(6);

    const funcSymbol = result.symbols.find((s) => s.name === "formatCurrency");
    expect(funcSymbol).toBeDefined();
    expect(funcSymbol!.line_start).toBe(12);
    expect(funcSymbol!.line_end).toBe(14);
    expect(funcSymbol!.line_count).toBe(3);
  });
});
