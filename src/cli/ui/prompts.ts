import * as readline from "node:readline";
import type { HarnessOption } from "../scaffold/harness-config.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export async function promptSelectHarnesses(options: HarnessOption[]): Promise<string[]> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Non-interactive fallback (CI/scripts/piped): return default selections
    return options.filter((o) => o.selectedByDefault).map((o) => o.id);
  }

  const selected = new Set<string>(
    options.filter((o) => o.selectedByDefault).map((o) => o.id)
  );
  let cursor = 0;

  process.stdout.write(HIDE_CURSOR);

  function render(firstTime: boolean = false) {
    if (!firstTime) {
      // Move up by number of options + header lines
      readline.moveCursor(process.stdout, 0, -(options.length + 2));
    }

    readline.clearLine(process.stdout, 0);
    console.log(
      `${CYAN}◇${RESET}  ${BOLD}Select AI Agent Harnesses for this project:${RESET} ${DIM}(Space: toggle, Enter: confirm, 'a': all)${RESET}`
    );
    readline.clearLine(process.stdout, 0);
    console.log(`${CYAN}│${RESET}`);

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isCurrent = i === cursor;
      const isChecked = selected.has(opt.id);

      const pointer = isCurrent ? `${CYAN}❯${RESET}` : " ";
      const box = isChecked ? `${GREEN}[●]${RESET}` : `${DIM}[○]${RESET}`;
      const name = isCurrent ? `${BOLD}${opt.name}${RESET}` : opt.name;
      const file = `${DIM}(${opt.targetFile})${RESET}`;

      readline.clearLine(process.stdout, 0);
      console.log(`${CYAN}│${RESET}  ${pointer} ${box} ${name.padEnd(26)} ${file}`);
    }
  }

  render(true);

  return new Promise<string[]>((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onKeypress = (str: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(130);
      }

      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + options.length) % options.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % options.length;
        render();
      } else if (key.name === "space") {
        const id = options[cursor].id;
        if (selected.has(id)) {
          selected.delete(id);
        } else {
          selected.add(id);
        }
        render();
      } else if (str === "a" || str === "A") {
        if (selected.size === options.length) {
          selected.clear();
        } else {
          for (const opt of options) selected.add(opt.id);
        }
        render();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        // Clear prompt display and print finalized selection summary
        readline.moveCursor(process.stdout, 0, -(options.length + 2));
        for (let i = 0; i < options.length + 2; i++) {
          readline.clearLine(process.stdout, 0);
          readline.moveCursor(process.stdout, 0, 1);
        }
        readline.moveCursor(process.stdout, 0, -(options.length + 2));

        const names = options
          .filter((o) => selected.has(o.id))
          .map((o) => o.name)
          .join(", ");
        console.log(
          `${GREEN}✓${RESET}  ${BOLD}Configured AI Harnesses:${RESET} ${names || `${YELLOW}None (skipped)${RESET}`}`
        );
        console.log(`${CYAN}│${RESET}`);

        resolve(Array.from(selected));
      }
    };

    function cleanup() {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write(SHOW_CURSOR);
    }

    process.stdin.on("keypress", onKeypress);
  });
}

