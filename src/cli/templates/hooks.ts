export const SEPTUM_HOOKS_CONFIG = {
  "septum-boundary-guard": {
    "PreToolUse": [
      {
        "matcher": "write_to_file|replace_file_content",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'HOOK=\"$(git rev-parse --show-toplevel 2>/dev/null)/.agents/hooks/septum-pre-write.sh\"; if [ -f \"$HOOK\" ]; then exec \"$HOOK\"; else exit 0; fi'",
            "timeout": 10,
          },
        ],
      },
    ],
    "PostToolUse": [
      {
        "matcher": "write_to_file|replace_file_content",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'HOOK=\"$(git rev-parse --show-toplevel 2>/dev/null)/.agents/hooks/septum-post-write.sh\"; if [ -f \"$HOOK\" ]; then exec \"$HOOK\"; else exit 0; fi'",
            "timeout": 15,
          },
        ],
      },
    ],
  },
};

export const SEPTUM_PRE_WRITE_SCRIPT = `#!/usr/bin/env sh
# Septum 3-Gate Boundary Guard Pre-Write Hook
# Intercepts write_to_file and replace_file_content before disk mutation

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [ ! -f "$ROOT_DIR/.septum/septum.db" ]; then
  exit 0
fi

# Delegate directly to Septum's active 3-gate hook engine
if command -v bun >/dev/null 2>&1 && [ -f "$ROOT_DIR/bin/septum.ts" ]; then
  exec bun run "$ROOT_DIR/bin/septum.ts" hook pre-write
elif command -v septum >/dev/null 2>&1; then
  exec septum hook pre-write
elif [ -f "$ROOT_DIR/node_modules/.bin/septum" ]; then
  exec "$ROOT_DIR/node_modules/.bin/septum" hook pre-write
elif command -v bunx >/dev/null 2>&1; then
  exec bunx septum hook pre-write
fi

exit 0
`;

export const SEPTUM_POST_WRITE_SCRIPT = `#!/usr/bin/env sh
# Septum Automated Incremental Post-Write Hook
# Syncs modified AST into SQLite SSOT after file mutations

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [ ! -f "$ROOT_DIR/.septum/septum.db" ]; then
  exit 0
fi

# Trigger background incremental sync
if command -v bun >/dev/null 2>&1 && [ -f "$ROOT_DIR/bin/septum.ts" ]; then
  bun run "$ROOT_DIR/bin/septum.ts" sync --json >/dev/null 2>&1 &
elif command -v septum >/dev/null 2>&1; then
  septum sync --json >/dev/null 2>&1 &
elif [ -f "$ROOT_DIR/node_modules/.bin/septum" ]; then
  "$ROOT_DIR/node_modules/.bin/septum" sync --json >/dev/null 2>&1 &
elif command -v bunx >/dev/null 2>&1; then
  bunx septum sync --json >/dev/null 2>&1 &
fi

exit 0
`;

