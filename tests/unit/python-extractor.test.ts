import { describe, expect, it } from "bun:test";
import { PythonExtractor } from "../../src/core/parser/extractors/python.ts";

describe("PythonExtractor", () => {
  const extractor = new PythonExtractor();

  it("should identify python files by extension", () => {
    expect(extractor.canHandle("src/domains/billing/service.py")).toBe(true);
    expect(extractor.canHandle("src/domains/billing/service.ts")).toBe(false);
  });

  it("should extract absolute and relative imports with external detection", async () => {
    const pythonCode = `
import os
import sys
from typing import Optional, List
from pydantic import BaseModel

import src.domains.orders.service as order_service
from ..billing.services import PaymentService
from .helper import format_currency
`;

    const ast = await extractor.extract("src/domains/billing/main.py", pythonCode);

    expect(ast.dependencies.length).toBe(7);

    // os, sys, typing, pydantic should be marked external
    const osDep = ast.dependencies.find((d) => d.target === "os");
    expect(osDep?.is_external).toBe(true);

    const pydanticDep = ast.dependencies.find((d) => d.target === "pydantic");
    expect(pydanticDep?.is_external).toBe(true);

    // Internal imports should not be external
    const ordersDep = ast.dependencies.find((d) => d.target === "src.domains.orders.service");
    expect(ordersDep?.is_external).toBe(false);

    const relBillingDep = ast.dependencies.find((d) => d.target === "..billing.services");
    expect(relBillingDep?.is_external).toBe(false);
  });

  it("should extract classes and functions with proper kinds and visibility", async () => {
    const pythonCode = `
class InvoiceProcessor:
    def __init__(self, currency: str):
        self.currency = currency

    def calculate_total(self, items: list) -> float:
        return 100.0

    def _internal_helper(self):
        pass

    def __private_method(self):
        pass

def standalone_helper():
    pass

async def async_dispatch_event():
    pass
`;

    const ast = await extractor.extract("src/domains/billing/processor.py", pythonCode);

    // Class
    const classSym = ast.symbols.find((s) => s.name === "InvoiceProcessor");
    expect(classSym?.kind).toBe("class");
    expect(classSym?.visibility).toBe("public");

    // Methods
    const calcMethod = ast.symbols.find((s) => s.name === "InvoiceProcessor::calculate_total");
    expect(calcMethod?.kind).toBe("method");
    expect(calcMethod?.visibility).toBe("public");

    const protectedMethod = ast.symbols.find((s) => s.name === "InvoiceProcessor::_internal_helper");
    expect(protectedMethod?.visibility).toBe("protected");

    const privateMethod = ast.symbols.find((s) => s.name === "InvoiceProcessor::__private_method");
    expect(privateMethod?.visibility).toBe("private");

    // Standalone functions
    const standalone = ast.symbols.find((s) => s.name === "standalone_helper");
    expect(standalone?.kind).toBe("function");

    const asyncFunc = ast.symbols.find((s) => s.name === "async_dispatch_event");
    expect(asyncFunc?.kind).toBe("function");
  });
});
