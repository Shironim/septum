import { describe, expect, it } from "bun:test";
import { calculateControlFlowNesting, calculatePythonNesting } from "../../src/core/parser/boundary-tracker.ts";
import { LaravelMigrationSchemaProvider } from "../../src/core/parser/schema/providers/laravel-migration-provider.ts";
import { PrismaSchemaProvider } from "../../src/core/parser/schema/providers/prisma-schema-provider.ts";
import { SchemaProviderRegistry } from "../../src/core/parser/schema/schema-provider-registry.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("Cyclomatic Nesting Depth Detector", () => {
  it("should calculate correct nesting depth for clean single-level function", () => {
    const code = [
      "function cleanFunction($x) {",
      "  $y = $x * 2;",
      "  return $y + 10;",
      "}",
    ];
    const depth = calculateControlFlowNesting(code, 0, code.length - 1);
    expect(depth).toBe(1);
  });

  it("should calculate nesting depth for nested if and loop (> 4)", () => {
    const code = [
      "function complexHandler($items) {",     // level 1
      "  if (!empty($items)) {",               // level 2
      "    foreach ($items as $item) {",       // level 3
      "      try {",                           // level 4
      "        if ($item->price > 100) {",     // level 5
      "          while ($retryCount < 3) {",   // level 6
      "            $this->dispatch();",
      "          }",
      "        }",
      "      } catch (\\Exception $e) {",
      "        Log::error($e);",
      "      }",
      "    }",
      "  }",
      "  return true;",
      "}",
    ];
    const depth = calculateControlFlowNesting(code, 0, code.length - 1);
    expect(depth).toBe(6);
  });

  it("should ignore object literals and comments when calculating depth", () => {
    const code = [
      "function renderConfig() {",
      "  // if ($fake) {",
      "  /*",
      "     while ($anotherFake) {",
      "  */",
      "  const config = {",
      "    db: {",
      "      host: 'localhost',",
      "      port: 3306",
      "    }",
      "  };",
      "  return config;",
      "}",
    ];
    const depth = calculateControlFlowNesting(code, 0, code.length - 1);
    expect(depth).toBe(1);
  });

  it("should calculate Python indentation nesting accurately", () => {
    const code = [
      "def process_order(order):",         // level 1
      "    if order.is_valid:",            // level 2
      "        for item in order.items:",  // level 3
      "            try:",                  // level 4
      "                if item.count > 0:",// level 5
      "                    pass",
      "            except Exception:",
      "                pass",
      "    return True",
    ];
    const depth = calculatePythonNesting(code, 0, code.length - 1);
    expect(depth).toBe(5);
  });
});

describe("Schema-First Entity Linkage & SPI", () => {
  it("should crawl Laravel migrations and extract column definitions", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-test-laravel-"));
    const migDir = path.join(tmpDir, "database", "migrations");
    fs.mkdirSync(migDir, { recursive: true });

    const migrationContent = `<?php
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration {
    public function up(): void {
        Schema::create('orders', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained();
            $table->string('order_number')->unique();
            $table->decimal('total_amount', 10, 2);
            $table->string('status')->default('pending');
            $table->text('notes')->nullable();
            $table->timestamps();
        });
    }
};
`;
    fs.writeFileSync(path.join(migDir, "2024_01_01_000000_create_orders_table.php"), migrationContent);

    const provider = new LaravelMigrationSchemaProvider();
    expect(provider.canHandle(tmpDir)).toBe(true);

    const schema = provider.resolveEntitySchema(tmpDir, "Order");
    expect(schema).not.toBeNull();
    expect(schema?.tableName).toBe("orders");
    expect(schema?.fields.length).toBeGreaterThanOrEqual(6);

    const colNames = schema?.fields.map((f) => f.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("user_id");
    expect(colNames).toContain("order_number");
    expect(colNames).toContain("total_amount");
    expect(colNames).toContain("status");
    expect(colNames).toContain("notes");

    const notesCol = schema?.fields.find((f) => f.name === "notes");
    expect(notesCol?.nullable).toBe(true);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should extract Prisma schema model definitions", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-test-prisma-"));
    const prismaDir = path.join(tmpDir, "prisma");
    fs.mkdirSync(prismaDir, { recursive: true });

    const prismaContent = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      String   @default("user")
  createdAt DateTime @default(now())
}
`;
    fs.writeFileSync(path.join(prismaDir, "schema.prisma"), prismaContent);

    const provider = new PrismaSchemaProvider();
    expect(provider.canHandle(tmpDir)).toBe(true);

    const schema = provider.resolveEntitySchema(tmpDir, "User");
    expect(schema).not.toBeNull();
    expect(schema?.entityName).toBe("User");
    expect(schema?.tableName).toBe("user");

    const colNames = schema?.fields.map((f) => f.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("email");
    expect(colNames).toContain("name");
    expect(colNames).toContain("role");

    const nameCol = schema?.fields.find((f) => f.name === "name");
    expect(nameCol?.nullable).toBe(true);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should resolve schema polimorphically through SchemaProviderRegistry", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "septum-test-registry-"));
    const migDir = path.join(tmpDir, "database", "migrations");
    fs.mkdirSync(migDir, { recursive: true });

    const migrationContent = `<?php
Schema::create('products', function (Blueprint $table) {
    $table->id();
    $table->string('title');
    $table->integer('stock');
    $table->timestamps();
});
`;
    fs.writeFileSync(path.join(migDir, "2024_01_01_000000_create_products_table.php"), migrationContent);

    const schema = SchemaProviderRegistry.resolveSchema(tmpDir, "Product");
    expect(schema).not.toBeNull();
    expect(schema?.tableName).toBe("products");
    expect(schema?.fields.some((f) => f.name === "title")).toBe(true);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
