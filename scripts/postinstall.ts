#!/usr/bin/env bun
import { SEPTUM_VERSION } from "../src/version.ts";

function printBanner(): void {
  const v = `v${SEPTUM_VERSION}`;
  console.log(`
\x1b[36m╭─────────────────────────────────────────────────────────────╮\x1b[0m
\x1b[36m│\x1b[0m                                                             \x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m   \x1b[32m✓\x1b[0m \x1b[1mSeptum ${v}\x1b[0m successfully installed!                  \x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m                                                             \x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m   \x1b[1mNext Steps:\x1b[0m                                               \x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m   1. Navigate to your project directory:                    \x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m      \x1b[36m$ cd /path/to/your-project\x1b[0m                             \x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m   2. Initialize local guard & configure AI agent harness:   \x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m      \x1b[36m$ septum init\x1b[0m                                          \x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m                                                             \x1b[36m│\x1b[0m
\x1b[36m╰─────────────────────────────────────────────────────────────╯\x1b[0m
`);
}

try {
  printBanner();
} catch {
  // Postinstall output failure should never abort installation
}
