import { describe, expect, it } from "bun:test";
import { TypeScriptExtractor } from "../../src/core/parser/extractors/typescript.ts";
import { FrontendExtractor } from "../../src/core/parser/extractors/frontend.ts";

describe("TS-01 — TypeScript / JavaScript AST Precision & Local Declarations", () => {
  const extractor = new TypeScriptExtractor();

  describe("Re-exports in dependencies", () => {
    it("extracts named re-exports into dependencies with imported symbols", async () => {
      const code = `
export { foo as bar, baz } from "./utils";
export type { UserType } from "./types";
export * from "./all";
export * as helpers from "./helpers";
`;
      const ast = await extractor.extract("index.ts", code);
      expect(ast.status).toBe("parsed");

      const utilsDep = ast.dependencies.find((d) => d.target === "./utils");
      expect(utilsDep).toBeDefined();
      expect(utilsDep?.statement).toContain("export { foo as bar, baz } from \"./utils\"");
      expect(utilsDep?.imported_symbols).toContain("foo");
      expect(utilsDep?.imported_symbols).toContain("bar");
      expect(utilsDep?.imported_symbols).toContain("baz");

      const allDep = ast.dependencies.find((d) => d.target === "./all");
      expect(allDep).toBeDefined();
      expect(allDep?.statement).toContain("export * from \"./all\"");

      const helpersDep = ast.dependencies.find((d) => d.target === "./helpers");
      expect(helpersDep).toBeDefined();
      expect(helpersDep?.imported_symbols).toContain("helpers");

      const typeDep = ast.dependencies.find((d) => d.target === "./types");
      expect(typeDep).toBeDefined();
      expect(typeDep?.imported_symbols).toContain("UserType");
    });
  });

  describe("Destructuring variable declarations", () => {
    it("extracts object destructuring pattern symbols", async () => {
      const code = `
export const { query, count: totalCount, active = true } = config;
const { internalA, internalB } = require("./internal");
`;
      const ast = await extractor.extract("config.ts", code);
      expect(ast.status).toBe("parsed");

      const querySym = ast.symbols.find((s) => s.name === "query");
      expect(querySym).toBeDefined();
      expect(querySym?.kind).toBe("constant");
      expect(querySym?.visibility).toBe("public");

      const totalSym = ast.symbols.find((s) => s.name === "totalCount");
      expect(totalSym).toBeDefined();
      expect(totalSym?.kind).toBe("constant");
      expect(totalSym?.visibility).toBe("public");

      const activeSym = ast.symbols.find((s) => s.name === "active");
      expect(activeSym).toBeDefined();
      expect(activeSym?.kind).toBe("constant");
      expect(activeSym?.visibility).toBe("public");

      const internalASym = ast.symbols.find((s) => s.name === "internalA");
      expect(internalASym).toBeDefined();
      expect(internalASym?.kind).toBe("constant");
      expect(internalASym?.visibility).toBe("private");
    });

    it("extracts array destructuring pattern symbols", async () => {
      const code = `
export const [firstItem, , thirdItem = "default"] = items;
let [count, setCount] = [0, () => {}];
`;
      const ast = await extractor.extract("items.ts", code);
      expect(ast.status).toBe("parsed");

      const firstSym = ast.symbols.find((s) => s.name === "firstItem");
      expect(firstSym).toBeDefined();
      expect(firstSym?.kind).toBe("constant");
      expect(firstSym?.visibility).toBe("public");

      const thirdSym = ast.symbols.find((s) => s.name === "thirdItem");
      expect(thirdSym).toBeDefined();
      expect(thirdSym?.kind).toBe("constant");

      const countSym = ast.symbols.find((s) => s.name === "count");
      expect(countSym).toBeDefined();
      expect(countSym?.kind).toBe("variable");
      expect(countSym?.visibility).toBe("private");

      const setCountSym = ast.symbols.find((s) => s.name === "setCount");
      expect(setCountSym).toBeDefined();
      expect(setCountSym?.kind).toBe("variable");
    });
  });

  describe("Constructor parameter properties & class access modifiers", () => {
    it("extracts constructor parameter properties as class members", async () => {
      const code = `
export class OrderService {
  #internalId: string = "secret";
  private retryLimit: number = 3;
  protected loggerLevel: string = "info";

  constructor(
    private readonly repo: OrderRepository,
    protected readonly logger: Logger,
    public readonly eventBus: EventBus,
    unpromotedParam: string
  ) {}

  #computeInternalHash(): string {
    return this.#internalId;
  }
}
`;
      const ast = await extractor.extract("OrderService.ts", code);
      expect(ast.status).toBe("parsed");

      const repoSym = ast.symbols.find((s) => s.name === "OrderService::repo");
      expect(repoSym).toBeDefined();
      expect(repoSym?.kind).toBe("property");
      expect(repoSym?.visibility).toBe("private");

      const loggerSym = ast.symbols.find((s) => s.name === "OrderService::logger");
      expect(loggerSym).toBeDefined();
      expect(loggerSym?.kind).toBe("property");
      expect(loggerSym?.visibility).toBe("protected");

      const eventBusSym = ast.symbols.find((s) => s.name === "OrderService::eventBus");
      expect(eventBusSym).toBeDefined();
      expect(eventBusSym?.kind).toBe("property");
      expect(eventBusSym?.visibility).toBe("public");

      // Unpromoted param should NOT be extracted as class property
      const unpromotedSym = ast.symbols.find((s) => s.name === "OrderService::unpromotedParam");
      expect(unpromotedSym).toBeUndefined();

      // #internalId private identifier
      const hashIdSym = ast.symbols.find((s) => s.name === "OrderService::#internalId");
      expect(hashIdSym).toBeDefined();
      expect(hashIdSym?.visibility).toBe("private");

      // #computeInternalHash private method
      const hashMethodSym = ast.symbols.find((s) => s.name === "OrderService::#computeInternalHash");
      expect(hashMethodSym).toBeDefined();
      expect(hashMethodSym?.kind).toBe("method");
      expect(hashMethodSym?.visibility).toBe("private");
    });
  });

  describe("FrontendExtractor coupling regression check", () => {
    it("preserves script symbol and dependency extraction in Vue SFCs", async () => {
      const frontend = new FrontendExtractor();
      const vueSfc = `
<template>
  <div>{{ title }}</div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { UserService } from "@/services/user";
export { formatUser } from "./formatter";

const title = ref("User Profile");
const { activeUser, permissions } = UserService.getCurrent();
</script>
`;
      const ast = await frontend.extract("UserView.vue", vueSfc);
      expect(ast.dependencies.some((d) => d.target === "vue")).toBe(true);
      expect(ast.dependencies.some((d) => d.target === "@/services/user")).toBe(true);
      expect(ast.dependencies.some((d) => d.target === "./formatter")).toBe(true);
      expect(ast.symbols.some((s) => s.name === "title")).toBe(true);
      expect(ast.symbols.some((s) => s.name === "activeUser")).toBe(true);
    });
  });
});

