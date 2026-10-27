export const SEPTUM_HOOKS_CONFIG = {
  "septum-boundary-guard": {
    "PreToolUse": [
      {
        "matcher": "write_to_file|replace_file_content|multi_replace_file_content|Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'ROOT=\"$(pwd -P)\"; for d in .gemini .claude .codex opencode .agents; do if [ -f \"$ROOT/$d/hooks/septum-pre-write.sh\" ]; then exec \"$ROOT/$d/hooks/septum-pre-write.sh\" \"$@\"; fi; done; exit 0'",
            "timeout": 10,
          },
        ],
      },
    ],
    "PostToolUse": [
      {
        "matcher": "write_to_file|replace_file_content|multi_replace_file_content|Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'ROOT=\"$(pwd -P)\"; for d in .gemini .claude .codex opencode .agents; do if [ -f \"$ROOT/$d/hooks/septum-post-write.sh\" ]; then exec \"$ROOT/$d/hooks/septum-post-write.sh\" \"$@\"; fi; done; exit 0'",
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

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
if [ ! -f "$ROOT_DIR/.septum/septum.db" ]; then
  exit 0
fi

# Delegate directly to Septum's active 3-gate hook engine
if command -v bun >/dev/null 2>&1 && [ -f "$ROOT_DIR/bin/septum.ts" ]; then
  exec bun run "$ROOT_DIR/bin/septum.ts" hook pre-write "$@"
elif command -v septum >/dev/null 2>&1; then
  exec septum hook pre-write "$@"
elif [ -f "$ROOT_DIR/node_modules/.bin/septum" ]; then
  exec "$ROOT_DIR/node_modules/.bin/septum" hook pre-write "$@"
elif command -v bunx >/dev/null 2>&1; then
  exec bunx septum hook pre-write "$@"
fi

exit 0
`;

export const SEPTUM_POST_WRITE_SCRIPT = `#!/usr/bin/env sh
# Septum Automated Incremental Post-Write Hook
# Syncs modified AST into SQLite SSOT after file mutations

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)"
if [ ! -f "$ROOT_DIR/.septum/septum.db" ]; then
  exit 0
fi

# Trigger background incremental sync
if command -v bun >/dev/null 2>&1 && [ -f "$ROOT_DIR/bin/septum.ts" ]; then
  bun run "$ROOT_DIR/bin/septum.ts" sync >/dev/null 2>&1 &
elif command -v septum >/dev/null 2>&1; then
  septum sync >/dev/null 2>&1 &
elif [ -f "$ROOT_DIR/node_modules/.bin/septum" ]; then
  "$ROOT_DIR/node_modules/.bin/septum" sync >/dev/null 2>&1 &
elif command -v bunx >/dev/null 2>&1; then
  bunx septum sync >/dev/null 2>&1 &
fi

exit 0
`;

