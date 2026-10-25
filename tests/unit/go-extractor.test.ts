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
    expect(structSym?.kind).toBe("struct");
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

  it("should extract type definitions, type aliases, and grouped constants (GO-01)", async () => {
    const goCode = `package billing

const (
    StatusPending = "pending"
    StatusActive  = "active"
    internalCode  = 100
)

const DefaultTimeout = 30

type UserID int
type StringList []string
type HandlerFunc func(string) error

type Store[T any] struct {
    items []T
}

func (s *Store[T]) Get(id string) *T {
    return nil
}

func (s Store[T]) Count() int {
    return len(s.items)
}

func (*Store[T]) Reset() {
}
`;

    const ast = await extractor.extract("src/domains/billing/store.go", goCode);

    // Constants
    const pendingConst = ast.symbols.find((s) => s.name === "StatusPending");
    expect(pendingConst?.kind).toBe("constant");
    expect(pendingConst?.visibility).toBe("public");

    const internalConst = ast.symbols.find((s) => s.name === "internalCode");
    expect(internalConst?.kind).toBe("constant");
    expect(internalConst?.visibility).toBe("private");

    const timeoutConst = ast.symbols.find((s) => s.name === "DefaultTimeout");
    expect(timeoutConst?.kind).toBe("constant");
    expect(timeoutConst?.visibility).toBe("public");

    // Type definitions
    const userIdType = ast.symbols.find((s) => s.name === "UserID");
    expect(userIdType?.kind).toBe("type");
    expect(userIdType?.visibility).toBe("public");

    // Generic Struct
    const storeStruct = ast.symbols.find((s) => s.name === "Store");
    expect(storeStruct?.kind).toBe("struct");
    expect(storeStruct?.visibility).toBe("public");

    // Generic Methods
    const getMethod = ast.symbols.find((s) => s.name === "Get");
    expect(getMethod?.kind).toBe("method");
    expect(getMethod?.signature).toContain("func (s *Store[T]) Get");

    const countMethod = ast.symbols.find((s) => s.name === "Count");
    expect(countMethod?.kind).toBe("method");
    expect(countMethod?.signature).toContain("func (s Store[T]) Count");

    const resetMethod = ast.symbols.find((s) => s.name === "Reset");
    expect(resetMethod?.kind).toBe("method");
    expect(resetMethod?.signature).toContain("func (*Store[T]) Reset");
  });

  it("should handle degraded fallback extraction for constants, structs, and types", async () => {
    const goCode = `package billing

const (
    FlagA = 1
    FlagB = 2
)

type Config struct {
    Host string
}

type Port int

func (c *Config) Validate() bool {
    return true
}

func Helper() {}
`;

    // Extract using fallback directly
    // @ts-expect-error accessing private method for fallback verification
    const fallbackAst = extractor.extractFallback("src/domains/billing/fallback.go", goCode);

    expect(fallbackAst.symbols.some((s) => s.name === "FlagA" && s.kind === "constant")).toBe(true);
    expect(fallbackAst.symbols.some((s) => s.name === "Config" && s.kind === "struct")).toBe(true);
    expect(fallbackAst.symbols.some((s) => s.name === "Port" && s.kind === "type")).toBe(true);
    expect(fallbackAst.symbols.some((s) => s.name === "Validate" && s.kind === "method")).toBe(true);
    expect(fallbackAst.symbols.some((s) => s.name === "Helper" && s.kind === "function")).toBe(true);
  });
});
