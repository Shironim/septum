export const RESOURCE_LIMITS = Object.freeze({
  workspaces: 4,
  workspaceIdleMs: 10 * 60_000,
  watches: 2048,
  pendingPaths: 1000,
  debounceMs: 300,
  pollMs: 5000,
  verifyMs: 60_000,
  sourceBytes: 2 * 1024 * 1024,
  batchFiles: 50,
  batchBytes: 1024 * 1024,
  shutdownMs: 5000,
});
