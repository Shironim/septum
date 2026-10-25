import { describe, expect, it } from "bun:test";
import { ASTParserEngine } from "../../src/core/parser/tree-sitter.ts";

describe("Multi-Language AST Extractors (Rust, Java, C#, Ruby)", () => {
  const engine = new ASTParserEngine();

  describe("RustExtractor", () => {
    it("should extract Rust structs, enums, traits, methods, and use declarations", async () => {
      const rustCode = `
use std::collections::HashMap;
use crate::domain::model::Order;
use serde::Serialize;

pub enum OrderStatus {
    Pending,
    Completed,
    Cancelled,
}

pub struct OrderService {
    orders: HashMap<String, Order>,
}

pub trait Processable {
    fn process(&self) -> bool;
}

impl OrderService {
    pub fn cancel_order(&mut self, id: &str) -> bool {
        if id.is_empty() {
            return false;
        } else {
            match self.orders.get_mut(id) {
                Some(order) => {
                    true
                }
                None => false,
            }
        }
    }
}
      `.trim();

      const result = await engine.parseFile("src/services/order.rs", rustCode);
      expect(result.status).toBe("parsed");

      // Verify dependencies
      const deps = result.dependencies;
      expect(deps.length).toBe(3);
      expect(deps.some((d) => d.target.includes("HashMap") && d.is_external === true)).toBe(true);
      expect(deps.some((d) => d.target.includes("domain::model::Order") && d.is_external === false)).toBe(true);
      expect(deps.some((d) => d.target.includes("Serialize") && d.is_external === true)).toBe(true);

      // Verify symbols
      const symbols = result.symbols;
      expect(symbols.some((s) => s.name === "OrderStatus" && s.kind === "enum" && s.visibility === "public")).toBe(true);
      expect(symbols.some((s) => s.name === "OrderService" && s.kind === "struct" && s.visibility === "public")).toBe(true);
      expect(symbols.some((s) => s.name === "Processable" && s.kind === "interface" && s.visibility === "public")).toBe(true);

      const cancelMethod = symbols.find((s) => s.name === "OrderService::cancel_order");
      expect(cancelMethod).toBeDefined();
      expect(cancelMethod?.kind).toBe("method");
      expect(cancelMethod?.visibility).toBe("public");
      expect(cancelMethod?.line_count).toBeGreaterThan(5);
      expect(cancelMethod?.nesting_depth).toBeGreaterThanOrEqual(2);
    });
  });

  describe("JavaExtractor", () => {
    it("should extract Java classes, methods, imports, and calculate line metrics", async () => {
      const javaCode = `
package com.example.service;

import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
    private final List<String> cache;

    public OrderService() {
        this.cache = List.of();
    }

    public boolean validateAndProcess(String orderId) {
        if (orderId == null || orderId.isEmpty()) {
            return false;
        }
        for (String item : cache) {
            if (item.equals(orderId)) {
                return true;
            }
        }
        return false;
    }
}
      `.trim();

      const result = await engine.parseFile("src/main/java/com/example/OrderService.java", javaCode);
      expect(result.status).toBe("parsed");

      // Dependencies
      expect(result.dependencies.some((d) => d.target.includes("java.util.List"))).toBe(true);
      expect(result.dependencies.some((d) => d.target.includes("org.springframework.stereotype.Service"))).toBe(true);

      // Symbols
      const classSymbol = result.symbols.find((s) => s.name === "OrderService" && s.kind === "class");
      expect(classSymbol).toBeDefined();
      expect(classSymbol?.visibility).toBe("public");

      const methodSymbol = result.symbols.find((s) => s.name === "OrderService.validateAndProcess");
      expect(methodSymbol).toBeDefined();
      expect(methodSymbol?.kind).toBe("method");
      expect(methodSymbol?.visibility).toBe("public");
      expect(methodSymbol?.line_count).toBeGreaterThan(5);
      expect(methodSymbol?.nesting_depth).toBeGreaterThanOrEqual(2);
    });
  });

  describe("CSharpExtractor", () => {
    it("should extract C# classes, methods, using directives, and metrics", async () => {
      const csharpCode = `
using System;
using System.Collections.Generic;
using Microsoft.AspNetCore.Mvc;

namespace App.Controllers
{
    [ApiController]
    public class OrderController : ControllerBase
    {
        [HttpPost]
        public IActionResult ProcessOrder(string id)
        {
            if (string.IsNullOrEmpty(id))
            {
                return BadRequest("Invalid ID");
            }

            foreach (var step in new[] { "validate", "charge", "ship" })
            {
                if (step == "charge")
                {
                    Console.WriteLine("Charged");
                }
            }

            return Ok();
        }
    }
}
      `.trim();

      const result = await engine.parseFile("Controllers/OrderController.cs", csharpCode);
      expect(result.status).toBe("parsed");

      // Usings
      expect(result.dependencies.some((d) => d.target.includes("System"))).toBe(true);
      expect(result.dependencies.some((d) => d.target.includes("Microsoft.AspNetCore.Mvc"))).toBe(true);

      // Symbols
      const classSymbol = result.symbols.find((s) => s.name.includes("OrderController") && s.kind === "class");
      expect(classSymbol).toBeDefined();
      expect(classSymbol?.visibility).toBe("public");

      const methodSymbol = result.symbols.find((s) => s.name.includes("ProcessOrder") && s.kind === "method");
      expect(methodSymbol).toBeDefined();
      expect(methodSymbol?.visibility).toBe("public");
      expect(methodSymbol?.line_count).toBeGreaterThan(5);
      expect(methodSymbol?.nesting_depth).toBeGreaterThanOrEqual(2);
    });
  });

  describe("RubyExtractor", () => {
    it("should extract Ruby classes, modules, methods, requires, and nesting", async () => {
      const rubyCode = `
require 'json'
require_relative '../models/order'

module Billing
  class InvoiceService
    def initialize
      @active = true
    end

    def generate_invoice(order_id)
      if order_id.nil?
        return nil
      end

      [1, 2, 3].each do |step|
        if step == 2
          puts "Processing step 2"
        end
      end
    end
  end
end
      `.trim();

      const result = await engine.parseFile("services/invoice_service.rb", rubyCode);
      expect(result.status).toBe("parsed");

      // Dependencies
      expect(result.dependencies.some((d) => d.target === "json" && d.is_external === true)).toBe(true);
      expect(result.dependencies.some((d) => d.target.includes("models/order") && d.is_external === false)).toBe(true);

      // Symbols
      expect(result.symbols.some((s) => s.name.includes("Billing") && s.kind === "interface")).toBe(true);
      expect(result.symbols.some((s) => s.name.includes("InvoiceService") && s.kind === "class")).toBe(true);

      const methodSymbol = result.symbols.find((s) => s.name.includes("generate_invoice"));
      expect(methodSymbol).toBeDefined();
      expect(methodSymbol?.kind).toBe("method");
      expect(methodSymbol?.visibility).toBe("public");
      expect(methodSymbol?.line_count).toBeGreaterThan(4);
    });
  });
});
