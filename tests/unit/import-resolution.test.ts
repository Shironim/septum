import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ModuleResolver } from "../../src/core/resolver/module-resolver.ts";
import ts from "typescript";

describe("shared import resolution contract", () => {
 let root: string;
 beforeEach(() => { root = mkdtempSync(join(tmpdir(), "septum-resolution-")); });
 afterEach(() => rmSync(root, { recursive: true, force: true }));
 function put(file: string, text = "export class Target {}") { mkdirSync(dirname(join(root,file)),{recursive:true}); writeFileSync(join(root,file),text); }
 function resolve(target: string, source="src/main.ts") { return new ModuleResolver(root).resolveImport(target,source); }
 it("resolves literal relative targets and refuses missing local targets", () => {
  put("src/a.ts"); expect(resolve("./a").targets[0].files).toEqual(["src/a.ts"]);
  expect(resolve("./missing").status).toBe("unresolved");
  put("src/a.js"); expect(resolve("./a").status).toBe("ambiguous");
 });
 it("resolves TS aliases and invalidates a manifest-only edit", () => {
  put("src/a.ts"); put("lib/a.ts"); put("tsconfig.json",JSON.stringify({compilerOptions:{paths:{"@/*":["src/*"]}}}));
  const resolver = new ModuleResolver(root); const before = resolver.resolveImport("@/a","src/main.ts");
  expect(before.targets[0].files).toEqual(["src/a.ts"]);
  put("tsconfig.json",JSON.stringify({compilerOptions:{paths:{"@/*":["lib/*"]}}}));
  const after=resolver.resolveImport("@/a","src/main.ts"); expect(after.targets[0].files).toEqual(["lib/a.ts"]); expect(after.config_revision).not.toBe(before.config_revision);
 });
 it("uses tsconfig paths substitutions in order", () => {
  put("src/a.ts"); put("fallback/a.ts");
  put("tsconfig.json",JSON.stringify({compilerOptions:{baseUrl:".",paths:{"@/*":["src/*","fallback/*"]}}}));
  expect(resolve("@/a").targets[0].files).toEqual(["src/a.ts"]);
  rmSync(join(root,"src/a.ts"));
  expect(resolve("@/a").targets[0].files).toEqual(["fallback/a.ts"]);
 });
 it("respects baseUrl and explicit paths before workspace conventions or packages", () => {
  put("configs/service.ts"); put("service.ts"); put("src/blocked/service.ts");
  put("tsconfig.json", JSON.stringify({compilerOptions:{baseUrl:"./configs"}}));
  const configFile = join(root, "tsconfig.json");
  const typescriptTarget = (target: string) => {
    const config = ts.readConfigFile(configFile, ts.sys.readFile);
    const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configFile).options;
    return ts.resolveModuleName(target, join(root, "src/main.ts"), options, ts.sys).resolvedModule?.resolvedFileName;
  };
  expect(typescriptTarget("service")).toBe(join(root, "configs/service.ts"));
  expect(resolve("service").targets[0].files).toEqual(["configs/service.ts"]);
  put("tsconfig.json", JSON.stringify({extends:"./configs/base.json"}));
  put("configs/base.json", JSON.stringify({compilerOptions:{baseUrl:"."}}));
  expect(resolve("service").targets[0].files).toEqual(["configs/service.ts"]);
  put("tsconfig.json", JSON.stringify({compilerOptions:{baseUrl:".",paths:{"@/*":["missing/*"]}}}));
  expect(typescriptTarget("@/blocked/service")).toBeUndefined();
  expect(resolve("@/blocked/service").status).toBe("unresolved");
  put("package.json", JSON.stringify({dependencies:{"@/blocked":"1.0.0"}}));
  expect(resolve("@/blocked/service").status).toBe("external");
  put("package.json", JSON.stringify({workspaces:["packages/*"]}));
  put("packages/stock/package.json", JSON.stringify({name:"@scope/stock",main:"src/index.ts"}));
  put("packages/stock/src/index.ts");
  put("tsconfig.json", JSON.stringify({compilerOptions:{baseUrl:".",paths:{"@scope/*":["missing/*"]}}}));
  expect(resolve("@scope/stock").targets[0].files).toEqual(["packages/stock/src/index.ts"]);
  put("tsconfig.json", "{}");
  expect(resolve("@/blocked/service").targets[0].files).toEqual(["src/blocked/service.ts"]);
 });
 it("matches TypeScript for inherited paths, overrides and wildcard suffixes", () => {
  const compare = (target: string) => {
    const file = join(root, "tsconfig.json");
    const config = ts.readConfigFile(file, ts.sys.readFile);
    const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, file).options;
    const expected = ts.resolveModuleName(target, join(root, "src/main.ts"), options, ts.sys).resolvedModule?.resolvedFileName;
    const result = resolve(target);
    expect(result.targets.flatMap(t => t.files)).toEqual(expected ? [expected.slice(root.length + 1)] : []);
    return result;
  };
  put("configs/base.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@x/*": ["lib/*"] } } }));
  put("tsconfig.json", JSON.stringify({ extends: "./configs/base.json" }));
  put("configs/lib/a.ts"); put("lib/a.ts");
  expect(compare("@x/a").status).toBe("resolved");
  put("tsconfig.json", JSON.stringify({ extends: "./configs/base.json", compilerOptions: { paths: { "@y/*": ["src/*"] } } }));
  expect(compare("@x/a").status).toBe("unresolved");
  put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@pkg/*/util": ["lib/*/util"] } } }));
  put("lib/foo/util.ts"); expect(compare("@pkg/foo/util").status).toBe("resolved");
  put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@pkg/*": ["lib/*"], "@pkg/*/util": ["other/*/util"] } } }));
  put("other/foo/util.ts"); expect(compare("@pkg/foo/util").targets[0].files).toEqual(["lib/foo/util.ts"]);
  put("configs/second.json", JSON.stringify({ compilerOptions: { paths: { "@y/*": ["src/*"] } } }));
  put("tsconfig.json", JSON.stringify({ extends: ["./configs/base.json", "./configs/second.json"] }));
  expect(compare("@x/a").status).toBe("unresolved");
  put("node_modules/@config/base/package.json", JSON.stringify({ tsconfig: "tsconfig.json" }));
  put("node_modules/@config/base/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@x/*": ["lib/*"] } } }));
  put("node_modules/@config/base/lib/a.ts");
  put("tsconfig.json", JSON.stringify({ extends: "@config/base" }));
  expect(compare("@x/a").status).toBe("resolved");
  put("tsconfig.json", JSON.stringify({ extends: "./missing.json" }));
  expect(resolve("@x/a").status).toBe("unsupported");
  put("src/tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@x/*": ["lib/*"] } } }));
  expect(resolve("@x/a").reason).toBe("nested_tsconfig_project_selection_unknown");
 });
 it("handles PSR-4 arrays and distinguishes manifest-backed external from unknown", () => {
  put("composer.json",JSON.stringify({autoload:{"psr-4":{"App\\":["app/","lib/"]}},require:{"vendor/package":"^1"}}));
  put("app/Invoice.php","<?php class Invoice {}"); expect(resolve("App\\Invoice","app/main.php").targets[0].files).toEqual(["app/Invoice.php"]);
  put("lib/Invoice.php","<?php class Invoice {}"); expect(resolve("App\\Invoice","app/main.php").status).toBe("ambiguous");
  put("package.json",JSON.stringify({dependencies:{zod:"^3"}})); expect(resolve("zod").status).toBe("external"); expect(resolve("unknown-package").status).toBe("unresolved");
 });
 it("resolves declared workspace package entries without basename guessing",()=>{
  put("package.json",JSON.stringify({workspaces:["packages/*"]}));put("packages/stock/package.json",JSON.stringify({name:"@workspace/stock",main:"src/index.ts"}));put("packages/stock/src/index.ts");
  expect(resolve("@workspace/stock").targets[0].files).toEqual(["packages/stock/src/index.ts"]);
 });
 it("returns unsupported for malformed configuration and unsupported languages", () => {
  put("tsconfig.json","{bad"); expect(resolve("@/a").status).toBe("unsupported");
  expect(resolve("crate::a","src/lib.rs").status).toBe("unsupported");
 });
 it("refuses lexical and symlink escape", () => {
  expect(resolve("../../../etc/passwd").reason).toContain("outside_workspace");
  symlinkSync("/etc",join(root,"escape")); expect(resolve("../escape/passwd","src/main.ts").status).toBe("unsupported");
 });
 it("resolves a dotless Go module to a multi-file package before stdlib classification", () => {
  put("go.mod","module myapp\n\ngo 1.22\nrequire example.com/external v1.0.0\n"); put("internal/orders/a.go","package orders\nfunc A() {}"); put("internal/orders/b.go","package orders\nfunc B() {}");
  const result=resolve("myapp/internal/orders","cmd/main.go"); expect(result.status).toBe("resolved"); expect(result.targets[0].kind).toBe("package"); expect(result.targets[0].files).toEqual(["internal/orders/a.go","internal/orders/b.go"]);
  expect(resolve("fmt","cmd/main.go").status).toBe("external"); expect(resolve("myapp2/internal/orders","cmd/main.go").status).toBe("unresolved"); expect(resolve("example.com/external/api","cmd/main.go").status).toBe("external");
 });
 it("marks Go workspaces/replaces and conditional file sets explicitly", () => {
  put("go.mod","module myapp\nreplace example.com/a => ../a\n"); expect(resolve("myapp/a","main.go").status).toBe("unsupported");
  put("go.mod","module myapp\n"); put("a/a_linux.go","package a\nfunc A() {}"); expect(resolve("myapp/a","main.go").coverage).toBe("conditional");
  put("a/go.mod","module nested\n"); expect(resolve("myapp/a","main.go").status).toBe("unsupported");
 });
 it("resolves Python relative imports and package __init__.py entries", () => {
  put("app/views/order.py", "from ..services.order import Order"); put("app/services/order.py", "class Order: pass");
  expect(resolve("..services.order", "app/views/order.py").targets[0].files).toEqual(["app/services/order.py"]);
  put("app/helpers/__init__.py", "# helper package");
  expect(resolve(".helpers", "app/main.py").targets[0].files).toEqual(["app/helpers/__init__.py"]);
 });
 it("resolves Python absolute imports via src layout and detects ambiguity", () => {
  put("src/billing/service.py", "class BillingService: pass");
  expect(resolve("billing.service", "src/main.py").targets[0].files).toEqual(["src/billing/service.py"]);
  put("src/auth.py", ""); put("src/auth/__init__.py", "");
  expect(resolve("auth", "src/main.py").status).toBe("ambiguous");
 });
 it("distinguishes Python stdlib, manifest dependencies and undeclared packages", () => {
  expect(resolve("json", "src/main.py").status).toBe("external");
  expect(resolve("os.path", "src/main.py").status).toBe("external");
  expect(resolve("asyncio", "src/main.py").status).toBe("external");
  put("requirements.txt", "# Comment line\n--extra-index-url https://pypi.org/simple\nfastapi>=0.100.0\npydantic\ncelery==5.3.0  # async queue\n");
  expect(resolve("fastapi", "src/main.py").status).toBe("external");
  expect(resolve("pydantic.v1", "src/main.py").status).toBe("external");
  expect(resolve("celery", "src/main.py").status).toBe("external");
  expect(resolve("unregistered_lib", "src/main.py").status).toBe("unresolved");
  put("pyproject.toml", '[tool.poetry.dependencies]\nrequests = "^2.31"\n');
  expect(resolve("requests", "src/main.py").status).toBe("external");
 });
 it("safely rejects Python relative imports that attempt to escape workspace root", () => {
  put("src/main.py", "pass");
  const result = resolve("../../../../../etc/passwd", "src/main.py");
  expect(result.status).toBe("unsupported");
  expect(result.reason).toContain("outside_workspace");
 });
 it("resolves PHP standard library, vendor packages, and missing internal PSR-4 targets (PHP-02)", () => {
  put("app/main.php", "<?php");
  expect(resolve("DateTime", "app/main.php").status).toBe("external");
  expect(resolve("Exception", "app/main.php").status).toBe("external");
  expect(resolve("PDO", "app/main.php").status).toBe("external");
  expect(resolve("\\Closure", "app/main.php").status).toBe("external");

  put("composer.json", JSON.stringify({
    autoload: { "psr-4": { "App\\": "app/" } },
    require: {
      "guzzlehttp/guzzle": "^7.8",
      "monolog/monolog": "^3.5",
      "laravel/framework": "^11.0",
    },
  }));

  expect(resolve("GuzzleHttp\\Client", "app/main.php").status).toBe("external");
  expect(resolve("Monolog\\Logger", "app/main.php").status).toBe("external");
  expect(resolve("Illuminate\\Support\\Collection", "app/main.php").status).toBe("external");
  expect(resolve("Unknown\\Vendor\\Lib", "app/main.php").status).toBe("unresolved");

  // Internal PSR-4 namespace whose target file does not exist on disk
  const missingResult = resolve("App\\Services\\NonExistentService", "app/main.php");
  expect(missingResult.status).toBe("unresolved");
  expect(missingResult.reason).toBe("file_not_found");
 });

  it("resolves TS .js/.mjs/.cjs specifiers to corresponding .ts/.mts/.cts files (TS-02a)", () => {
    put("src/helpers.ts");
    expect(resolve("./helpers.js", "src/main.ts").targets[0].files).toEqual(["src/helpers.ts"]);

    put("src/async-util.mts");
    expect(resolve("./async-util.mjs", "src/main.ts").targets[0].files).toEqual(["src/async-util.mts"]);

    // If both .js and .ts exist on disk, resolution must be ambiguous
    put("src/ambig.js");
    put("src/ambig.ts");
    expect(resolve("./ambig.js", "src/main.ts").status).toBe("ambiguous");
  });

  it("resolves tsconfig.json relative extends with paths and baseUrl (TS-02b)", () => {
    put("tsconfig.base.json", JSON.stringify({ compilerOptions: { paths: { "@domain/*": ["src/domain/*"] } } }));
    put("tsconfig.json", JSON.stringify({ extends: "./tsconfig.base.json" }));
    put("src/domain/order.ts");

    const resolver = new ModuleResolver(root);
    const before = resolver.resolveImport("@domain/order", "src/main.ts");
    expect(before.targets[0].files).toEqual(["src/domain/order.ts"]);

    // Modifying parent tsconfig invalidates config_revision
    put("tsconfig.base.json", JSON.stringify({ compilerOptions: { paths: { "@domain/*": ["lib/domain/*"] } } }));
    const after = resolver.resolveImport("@domain/order", "src/main.ts");
    expect(after.config_revision).not.toBe(before.config_revision);
  });

  it("resolves workspace package conditional exports and subpath exports (TS-02c)", () => {
    put("package.json", JSON.stringify({ workspaces: ["packages/*"] }));
    put("packages/core/package.json", JSON.stringify({
      name: "@workspace/core",
      exports: {
        ".": { "import": "./src/index.ts", "require": "./dist/index.cjs" },
        "./utils": "./src/utils.ts",
      },
    }));
    put("packages/core/src/index.ts");
    put("packages/core/src/utils.ts");

    expect(resolve("@workspace/core", "src/main.ts").targets[0].files).toEqual(["packages/core/src/index.ts"]);
    expect(resolve("@workspace/core/utils", "src/main.ts").targets[0].files).toEqual(["packages/core/src/utils.ts"]);
  });
});
