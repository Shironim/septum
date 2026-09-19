import { describe, expect, it } from "bun:test";
import { GoExtractor } from "../../src/core/parser/extractors/go.ts";

describe("GoExtractor", () => {
  const extractor = new GoExtractor();

  it("should identify go files by extension", () => {
    expect(extractor.canHandle("src/domains/billing/service.go")).toBe(true);
    expect(extractor.canHandle("src/domains/billing/service.py")).toBe(false);
  });

  it("should extract single and block imports with stdlib detection", async () => {
    const goCode = `package billing

import "fmt"
import "net/http"

import (
    "context"
    "github.com/org/repo/src/domains/orders"
    "github.com/org/repo/src/domains/identity"
)
`;

    const ast = await extractor.extract("src/domains/billing/service.go", goCode);

    expect(ast.dependencies.length).toBe(5);

    const fmtDep = ast.dependencies.find((d) => d.target === "fmt");
    expect(fmtDep?.is_external).toBe(true);

    const httpDep = ast.dependencies.find((d) => d.target === "net/http");
    expect(httpDep?.is_external).toBe(true);

    const contextDep = ast.dependencies.find((d) => d.target === "context");
    expect(contextDep?.is_external).toBe(true);

    const ordersDep = ast.dependencies.find((d) => d.target.includes("orders"));
    expect(ordersDep?.is_external).toBe(false);
  });

  it("should extract structs, interfaces, methods, and functions with Go export visibility", async () => {
    const goCode = `package billing

type PaymentProcessor struct {
    client string
}

type Tokenizer interface {
    Tokenize() string
}

func (p *PaymentProcessor) ProcessPayment(amount int) bool {
    return true
}

func (p *PaymentProcessor) internalValidate() bool {
    return true
}

func NewPaymentProcessor() *PaymentProcessor {
    return &PaymentProcessor{}
}

func unexportedHelper() {
}
`;

    const ast = await extractor.extract("src/domains/billing/processor.go", goCode);

    // Struct
    const structSym = ast.symbols.find((s) => s.name === "PaymentProcessor");
    expect(structSym?.kind).toBe("class");
    expect(structSym?.visibility).toBe("public");

    // Interface
    const ifaceSym = ast.symbols.find((s) => s.name === "Tokenizer");
    expect(ifaceSym?.kind).toBe("interface");
    expect(ifaceSym?.visibility).toBe("public");

    // Public method
    const pubMethod = ast.symbols.find((s) => s.name === "ProcessPayment");
    expect(pubMethod?.kind).toBe("method");
    expect(pubMethod?.visibility).toBe("public");

    // Private method
    const privMethod = ast.symbols.find((s) => s.name === "internalValidate");
    expect(privMethod?.kind).toBe("method");
    expect(privMethod?.visibility).toBe("private");

    // Public function
    const pubFunc = ast.symbols.find((s) => s.name === "NewPaymentProcessor");
    expect(pubFunc?.kind).toBe("function");
    expect(pubFunc?.visibility).toBe("public");

    // Private function
    const privFunc = ast.symbols.find((s) => s.name === "unexportedHelper");
    expect(privFunc?.kind).toBe("function");
    expect(privFunc?.visibility).toBe("private");
  });
});
