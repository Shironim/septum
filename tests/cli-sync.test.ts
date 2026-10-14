import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleSyncCommand } from "../src/cli/commands/sync.ts";

describe("septum sync command", () => {
  const tempFixture = join(import.meta.dir, "temp-sync-fixture");

  beforeEach(() => {
    rmSync(tempFixture, { recursive: true, force: true });
    mkdirSync(join(tempFixture, "src"), { recursive: true });
    mkdirSync(join(tempFixture, ".septum"), { recursive: true });
    writeFileSync(join(tempFixture, "package.json"), JSON.stringify({ name: "sync-fixture" }));
    writeFileSync(join(tempFixture, "src", "index.ts"), "export const hello = 'world';\n");
  });

  afterEach(() => {
    rmSync(tempFixture, { recursive: true, force: true });
  });

  it("runs sync command without errors against isolated disposable fixture", async () => {
    await expect(handleSyncCommand({ json: true, workspaceRoot: tempFixture })).resolves.toBeUndefined();
  });
});
