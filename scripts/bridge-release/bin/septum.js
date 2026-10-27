#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// Critical invariant: Log warnings only to stderr to preserve MCP stdio JSON-RPC protocol on stdout
process.stderr.write(
  "\x1b[33m[septum]\x1b[0m NOTICE: Package 'septum' has moved to '@dimassetoid/septum-mcp'. Please upgrade: bun add -g @dimassetoid/septum-mcp\n"
);

const require = createRequire(import.meta.url);
let targetBin = null;

try {
  const pkgPath = require.resolve("@dimassetoid/septum-mcp/package.json");
  const pkgDir = pkgPath.replace(/package\.json$/, "");
  targetBin = `${pkgDir}bin/septum.ts`;
} catch {
  targetBin = null;
}

// Check bun availability
const isBun = typeof process.versions.bun !== "undefined";
let hasBun = isBun;
if (!hasBun) {
  try {
    const res = spawnSync("bun", ["--version"], { stdio: "ignore" });
    hasBun = res.status === 0;
  } catch {
    hasBun = false;
  }
}

if (!hasBun) {
  process.stderr.write(
    "\x1b[31m[septum]\x1b[0m ERROR: Septum requires Bun runtime (uses bun:sqlite). For non-Bun systems, install precompiled standalone binaries via:\n  curl -fsSL https://raw.githubusercontent.com/Shironim/septum-mcp/master/install.sh | bash\n"
  );
  process.exit(1);
}

const args = targetBin ? [targetBin, ...process.argv.slice(2)] : ["@dimassetoid/septum-mcp", ...process.argv.slice(2)];
const command = targetBin ? "bun" : "bunx";

const child = spawn(command, args, {
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
