import { SeptumDatabase } from "../src/core/database/client.ts";
import { SeptumRepository } from "../src/core/database/repository.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

  test("splits CamelCase and awards token similarity bonus", () => {
    const score = calculateSimilarity("calculateTotal", "recalculateOrder");
    expect(score).toBeGreaterThan(0.4);
  });

  test("scores internal typo high (> 0.85) without requiring prefix or substring match", () => {
    const score = calculateSimilarity("OrderControllr", "OrderController");
    expect(score).toBeGreaterThan(0.85);
  });

  test("scores adjacent character transposition high (> 0.8) via Damerau-Levenshtein", () => {
    const score = calculateSimilarity("getUser", "getUsre");
    expect(score).toBeGreaterThan(0.8);
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

describe("SymbolLocator catalog resolution", () => {
  let db: SeptumDatabase;
  let repo: SeptumRepository;
  let fileId: number;
  const filePath = "app/Http/Controllers/OrderController.php";
  beforeEach(() => {
    db = new SeptumDatabase(":memory:");
    repo = new SeptumRepository(db.raw);
    const domain = repo.upsertDomain("orders", { root: "app" });
    fileId = repo.upsertFile(domain, filePath, "controller", "fixture", 50);
    repo.replaceFileSymbols(fileId, [
      { name: "OrderController", kind: "class", signature: "class OrderController", visibility: "public", line_start: 1, line_end: 50, line_count: 50 },
      ...["index", "store", "destroy", "recalculateOrder"].map((name, i) => ({ name: `OrderController::${name}`, kind: "method" as const, signature: `public function ${name}()`, visibility: "public" as const, line_start: 12 + i * 6, line_end: 15 + i * 6, line_count: 4 })),
    ]);
  });
  afterEach(() => db.close());
  test("resolves missing method and suggests sibling recalculateOrder", () => {
    const result = new SymbolLocator(repo).locate("Method OrderController::calculateTotal() does not exist");
    expect(result.found).toBe(false);
    expect(result.file_path).toBe(filePath);
    for (const name of ["recalculateOrder", "index", "store", "destroy"]) expect(result.sibling_methods).toContain(name);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].name).toBe("recalculateOrder");
  });
  test("suggests candidate container and scoped member when container name has a typo", () => {
    const result = new SymbolLocator(repo).locate("Method OrderControllr::calculateTotal() does not exist");
    expect(result.found).toBe(false);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.message).toContain("OrderController");
  });
});
