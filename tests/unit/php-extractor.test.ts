import { describe, expect, it } from "bun:test";
import { PHPExtractor } from "../../src/core/parser/extractors/php.ts";

describe("PHPExtractor - Namespace, Traits, Enums & Members (PHP-01)", () => {
  const extractor = new PHPExtractor();

  describe("Happy Path", () => {
    it("extracts fully qualified class and method symbols within namespace", async () => {
      const phpCode = `<?php
namespace App\\Http\\Controllers;

class OrderController {
    public const MAX_PER_PAGE = 50;
    private string $cacheKey;

    public function index(): void {
        $result = 1;
    }
}
`;
      const ast = await extractor.extract("OrderController.php", phpCode);

      const classSym = ast.symbols.find((s) => s.name === "App\\Http\\Controllers\\OrderController");
      expect(classSym).toBeDefined();
      expect(classSym?.kind).toBe("class");
      expect(classSym?.visibility).toBe("public");

      const constSym = ast.symbols.find((s) => s.name === "App\\Http\\Controllers\\OrderController::MAX_PER_PAGE");
      expect(constSym).toBeDefined();
      expect(constSym?.kind).toBe("property");

      const propSym = ast.symbols.find((s) => s.name === "App\\Http\\Controllers\\OrderController::$cacheKey");
      expect(propSym).toBeDefined();
      expect(propSym?.kind).toBe("property");
      expect(propSym?.visibility).toBe("private");

      const methodSym = ast.symbols.find((s) => s.name === "App\\Http\\Controllers\\OrderController::index");
      expect(methodSym).toBeDefined();
      expect(methodSym?.kind).toBe("method");
      expect(methodSym?.visibility).toBe("public");
    });

    it("deconstructs grouped use statements into individual dependencies", async () => {
      const phpCode = `<?php
namespace App\\Http\\Controllers;

use App\\Services\\{OrderService, InvoiceService as Bill};
use App\\Models\\User;

class OrderController {}
`;
      const ast = await extractor.extract("OrderController.php", phpCode);

      const depOrder = ast.dependencies.find((d) => d.target === "App\\Services\\OrderService");
      expect(depOrder).toBeDefined();
      expect(depOrder?.imported_symbols).toContain("OrderService");

      const depInvoice = ast.dependencies.find((d) => d.target === "App\\Services\\InvoiceService");
      expect(depInvoice).toBeDefined();
      expect(depInvoice?.imported_symbols).toContain("Bill");

      const depUser = ast.dependencies.find((d) => d.target === "App\\Models\\User");
      expect(depUser).toBeDefined();
      expect(depUser?.imported_symbols).toContain("User");
    });

    it("extracts enum declarations and enum cases as property symbols", async () => {
      const phpCode = `<?php
namespace App\\Enums;

enum OrderStatus: string {
    case Pending = "pending";
    case Processing = "processing";
    case Completed = "completed";
}
`;
      const ast = await extractor.extract("OrderStatus.php", phpCode);

      const enumSym = ast.symbols.find((s) => s.name === "App\\Enums\\OrderStatus");
      expect(enumSym).toBeDefined();
      expect(enumSym?.kind).toBe("enum");

      const pendingCase = ast.symbols.find((s) => s.name === "App\\Enums\\OrderStatus::Pending");
      expect(pendingCase).toBeDefined();
      expect(pendingCase?.kind).toBe("property");
      expect(pendingCase?.visibility).toBe("public");

      const completedCase = ast.symbols.find((s) => s.name === "App\\Enums\\OrderStatus::Completed");
      expect(completedCase).toBeDefined();
      expect(completedCase?.kind).toBe("property");
    });

    it("extracts all elements from multi-property declarations", async () => {
      const phpCode = `<?php
namespace App\\Models;

class Account {
    public int $id, $status = 1;
    protected string $firstName, $lastName;
}
`;
      const ast = await extractor.extract("Account.php", phpCode);

      const propId = ast.symbols.find((s) => s.name === "App\\Models\\Account::$id");
      expect(propId).toBeDefined();
      expect(propId?.kind).toBe("property");
      expect(propId?.visibility).toBe("public");

      const propStatus = ast.symbols.find((s) => s.name === "App\\Models\\Account::$status");
      expect(propStatus).toBeDefined();
      expect(propStatus?.kind).toBe("property");
      expect(propStatus?.visibility).toBe("public");

      const propFirstName = ast.symbols.find((s) => s.name === "App\\Models\\Account::$firstName");
      expect(propFirstName).toBeDefined();
      expect(propFirstName?.kind).toBe("property");
      expect(propFirstName?.visibility).toBe("protected");

      const propLastName = ast.symbols.find((s) => s.name === "App\\Models\\Account::$lastName");
      expect(propLastName).toBeDefined();
      expect(propLastName?.kind).toBe("property");
      expect(propLastName?.visibility).toBe("protected");
    });
  });

  describe("Unhappy & Degraded Fallback", () => {
    it("handles fallback extraction without crashing and ignores trait use inside class body", () => {
      const phpCode = `<?php
namespace App\\Services;

use App\\Contracts\\PaymentInterface;

class PaymentService {
    use HasLogger;

    public function pay(): bool {
        return true;
    }
}
`;
      // Call private extractFallback directly via any cast to verify degraded mode
      const ast = (extractor as any).extractFallback(phpCode);

      const classSym = ast.symbols.find((s: any) => s.name === "App\\Services\\PaymentService");
      expect(classSym).toBeDefined();

      const payMethod = ast.symbols.find((s: any) => s.name === "App\\Services\\PaymentService::pay");
      expect(payMethod).toBeDefined();

      // Ensure 'use HasLogger' inside class body is NOT extracted as an external dependency
      const traitDep = ast.dependencies.find((d: any) => d.target.includes("HasLogger"));
      expect(traitDep).toBeUndefined();

      const ifaceDep = ast.dependencies.find((d: any) => d.target === "App\\Contracts\\PaymentInterface");
      expect(ifaceDep).toBeDefined();
    });
  });

  describe("Edge Cases", () => {
    it("differentiates two classes with identical short names in different bracketed namespaces", async () => {
      const phpCode = `<?php
namespace App\\V1 {
    class Order {
        public function getVersion(): string { return "v1"; }
    }
}

namespace App\\V2 {
    class Order {
        public function getVersion(): string { return "v2"; }
    }
}
`;
      const ast = await extractor.extract("OrderVersions.php", phpCode);

      const v1Order = ast.symbols.find((s) => s.name === "App\\V1\\Order");
      const v2Order = ast.symbols.find((s) => s.name === "App\\V2\\Order");
      expect(v1Order).toBeDefined();
      expect(v2Order).toBeDefined();
      expect(v1Order?.name).not.toBe(v2Order?.name);

      const v1Method = ast.symbols.find((s) => s.name === "App\\V1\\Order::getVersion");
      const v2Method = ast.symbols.find((s) => s.name === "App\\V2\\Order::getVersion");
      expect(v1Method).toBeDefined();
      expect(v2Method).toBeDefined();
    });

    it("does not classify closure/nested anonymous function as a class method", async () => {
      const phpCode = `<?php
namespace App\\Services;

class TaskRunner {
    public function execute(): void {
        $callback = function($item) {
            return $item * 2;
        };
        $arrow = fn($x) => $x + 1;
    }
}
`;
      const ast = await extractor.extract("TaskRunner.php", phpCode);

      const methods = ast.symbols.filter((s) => s.kind === "method");
      expect(methods.length).toBe(1);
      expect(methods[0].name).toBe("App\\Services\\TaskRunner::execute");
    });

    it("does not treat trait use inside class as an external dependency in AST mode", async () => {
      const phpCode = `<?php
namespace App\\Models;

use App\\Scopes\\ActiveScope;

class Article {
    use SoftDeletes, HasFactory;

    public function title(): string {
        return "Test";
    }
}
`;
      const ast = await extractor.extract("Article.php", phpCode);

      const softDeleteDep = ast.dependencies.find((d) => d.target.includes("SoftDeletes"));
      expect(softDeleteDep).toBeUndefined();

      const factoryDep = ast.dependencies.find((d) => d.target.includes("HasFactory"));
      expect(factoryDep).toBeUndefined();

      const scopeDep = ast.dependencies.find((d) => d.target === "App\\Scopes\\ActiveScope");
      expect(scopeDep).toBeDefined();
    });

    it("correctly preserves unnamespaced global classes", async () => {
      const phpCode = `<?php
class GlobalLegacyHelper {
    public function assist(): void {}
}
`;
      const ast = await extractor.extract("GlobalLegacyHelper.php", phpCode);

      const classSym = ast.symbols.find((s) => s.name === "GlobalLegacyHelper");
      expect(classSym).toBeDefined();
      expect(classSym?.kind).toBe("class");

      const methodSym = ast.symbols.find((s) => s.name === "GlobalLegacyHelper::assist");
      expect(methodSym).toBeDefined();
      expect(methodSym?.kind).toBe("method");
    });
  });
});

