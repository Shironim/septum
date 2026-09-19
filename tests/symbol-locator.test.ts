import { describe, expect, test } from "bun:test";
import { calculateSimilarity, SymbolLocator } from "../src/core/resolver/symbol-locator.ts";

describe("SymbolLocator Query Parser", () => {
  const dummyRepo: any = {};
  const locator = new SymbolLocator(dummyRepo);

  test("parses Laravel error string with method does not exist", () => {
    const errorStr = "Method OrderController::calculateTotal() does not exist";
    const parsed = locator.parseQuery(errorStr);
    expect(parsed.container).toBe("OrderController");
    expect(parsed.member).toBe("calculateTotal");
    expect(parsed.kind).toBe("method");
  });

  test("parses FQCN undefined method error", () => {
    const errorStr = "Call to undefined method App\\Http\\Controllers\\OrderController::calculateTotal()";
    const parsed = locator.parseQuery(errorStr);
    expect(parsed.container).toBe("App\\Http\\Controllers\\OrderController");
    expect(parsed.member).toBe("calculateTotal");
  });

  test("parses static call syntax", () => {
    const parsed = locator.parseQuery("OrderController::calculateTotal()");
    expect(parsed.container).toBe("OrderController");
    expect(parsed.member).toBe("calculateTotal");
  });

  test("parses arrow call syntax", () => {
    const parsed = locator.parseQuery("OrderController->calculateTotal()");
    expect(parsed.container).toBe("OrderController");
    expect(parsed.member).toBe("calculateTotal");
  });

  test("parses dot notation", () => {
    const parsed = locator.parseQuery("OrderController.calculateTotal");
    expect(parsed.container).toBe("OrderController");
    expect(parsed.member).toBe("calculateTotal");
  });

  test("parses bare member", () => {
    const parsed = locator.parseQuery("calculateTotal");
    expect(parsed.container).toBeUndefined();
    expect(parsed.member).toBe("calculateTotal");
  });
});

describe("calculateSimilarity & Fuzzy Matching", () => {
  test("exact matches return 1.0", () => {
    expect(calculateSimilarity("calculateTotal", "calculateTotal")).toBe(1.0);
  });

  test("suggests recalculateOrder when looking for calculateTotal", () => {
    const score = calculateSimilarity("calculateTotal", "recalculateOrder");
    // Shared token 'calculate' gives strong boost
    expect(score).toBeGreaterThan(0.4);
  });

  test("ranks closest method highest", () => {
    const query = "calculateTotal";
    const methods = ["index", "store", "destroy", "recalculateOrder"];
    
    const ranked = methods
      .map((m) => ({ name: m, score: calculateSimilarity(query, m) }))
      .sort((a, b) => b.score - a.score);

    expect(ranked[0].name).toBe("recalculateOrder");
  });
});

describe("SymbolLocator Mock Resolution", () => {
  test("resolves missing method and suggests sibling recalculateOrder", () => {
    const mockRepo: any = {
      findContainers: (name: string) => [
        {
          file: { id: 1, path: "app/Http/Controllers/OrderController.php" },
          symbol: { id: 10, name: "OrderController", kind: "class" },
        },
      ],
      getSymbolsByFileId: (fileId: number) => [
        { name: "OrderController::index", kind: "method", signature: "public function index()", line_start: 12, line_end: 15 },
        { name: "OrderController::store", kind: "method", signature: "public function store(Request $req)", line_start: 17, line_end: 25 },
        { name: "OrderController::destroy", kind: "method", signature: "public function destroy($id)", line_start: 27, line_end: 32 },
        { name: "OrderController::recalculateOrder", kind: "method", signature: "public function recalculateOrder($id)", line_start: 35, line_end: 50 },
      ],
    };

    const locator = new SymbolLocator(mockRepo);
    const result = locator.locate("Method OrderController::calculateTotal() does not exist");

    expect(result.found).toBe(false);
    expect(result.file_path).toBe("app/Http/Controllers/OrderController.php");
    expect(result.sibling_methods).toContain("recalculateOrder");
    expect(result.sibling_methods).toContain("index");
    expect(result.sibling_methods).toContain("store");
    expect(result.sibling_methods).toContain("destroy");
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].name).toBe("recalculateOrder");
  });
});
