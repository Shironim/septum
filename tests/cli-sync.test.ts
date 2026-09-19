import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleSyncCommand } from "../src/cli/commands/sync.ts";
import { handleInitCommand } from "../src/cli/commands/init.ts";

describe("septum sync command", () => {
  it("runs sync command without errors against active repository", async () => {
    // Should execute incremental sync cleanly
    await expect(handleSyncCommand({ json: true })).resolves.toBeUndefined();
  });
});
