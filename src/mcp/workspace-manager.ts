import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigLoader } from '../core/config/loader.ts';
import type { ValidatedSeptumConfig } from '../core/config/schema.ts';
import { SeptumDatabase } from '../core/database/client.ts';
import { SeptumRepository } from '../core/database/repository.ts';
import { BoundaryEvaluator } from '../core/boundary/evaluator.ts';
import { ModuleResolver } from '../core/resolver/module-resolver.ts';
import { findProjectRoot, isAppHostDirectory, PROJECT_ROOT_MARKERS, setLastKnownProjectRoot } from '../core/resolver/path-resolver.ts';
import { IngestionPipeline } from '../core/ingestion/pipeline.ts';
import { RESOURCE_LIMITS } from '../core/resources/limits.ts';
import { SerialWorkQueue } from '../core/resources/work-queue.ts';
import { WatchBudget, WorkspaceWatcher } from './workspace-watcher.ts';

export function resolveServerWorkspace(options: {workspacePath?: string; filePath?: string; fallbackRoot?: string; initial?: boolean; cwd?: string} = {}): string {
  const cwd = options.cwd || process.cwd();
  const explicit = options.workspacePath || (!options.filePath ? process.env.SEPTUM_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT : undefined);
  let root: string;
  if (explicit) root = resolve(cwd, explicit);
  else if (options.filePath && (isAbsolute(options.filePath) || /[\\/]/.test(options.filePath))) root = findProjectRoot(resolve(options.fallbackRoot || cwd, options.filePath));
  else if (options.fallbackRoot) root = options.fallbackRoot;
  else {
    if (!PROJECT_ROOT_MARKERS.some(marker => existsSync(join(cwd, marker)))) throw new Error('No project marker in CWD. Set SEPTUM_WORKSPACE_ROOT to an explicit workspace directory.');
    root = cwd;
  }
  root = realpathSync(root);
  if (!statSync(root).isDirectory() || root === dirname(root) || root === realpathSync(homedir()) || isAppHostDirectory(root)) throw new Error(`Unsafe Septum serve workspace: ${root}`);
  setLastKnownProjectRoot(root);
  return root;
}

export function isWorkspaceInitialized(root: string): boolean {
  try {
    return existsSync(join(root, "septum.config.json")) ||
           existsSync(join(root, ".septum", "septum.db")) ||
           existsSync(join(root, ".septum"));
  } catch {
    return false;
  }
}

export interface WorkspaceContext {
  root: string;
  config: ValidatedSeptumConfig;
  db: SeptumDatabase;
  repo: SeptumRepository;
  evaluator: BoundaryEvaluator;
  pipeline: IngestionPipeline;
  ready: Promise<void>;
  watcher: WorkspaceWatcher;
}
interface Entry { context: WorkspaceContext; leases: number; lastUsed: number; initializing: boolean; abort: AbortController; disposal?: Promise<void> }
export interface WorkspaceLease { context: WorkspaceContext; release(): void }

export class WorkspaceManager {
  private contexts = new Map<string, Entry>();
  private queue = new SerialWorkQueue();
  private budget = new WatchBudget();
  private disposals = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setInterval>;
  lastRoot?: string;
  constructor(private readonly now: () => number = Date.now) {
    this.idleTimer = setInterval(() => { void this.expireIdle().catch(error => console.error(`[Septum Cleanup Warning] ${String(error)}`)); }, 60_000);
    this.idleTimer.unref();
  }
  get size(): number { return this.contexts.size; }
  get watchCount(): number { return this.budget.count; }
  get syncDurationMs(): number { return Math.max(0, ...[...this.contexts.values()].map(entry => Number(entry.context.repo.getMeta("sync_duration_ms") || 0))); }
  get pendingPaths(): number { return [...this.contexts.values()].reduce((n, entry) => n + entry.context.watcher.pendingCount, 0); }

  acquire(rawRoot: string): WorkspaceLease {
    if (this.closed) throw new Error('Septum server is shutting down');
    const root = realpathSync(rawRoot);
    let entry = this.contexts.get(root);
    if (!entry) {
      if (this.contexts.size >= RESOURCE_LIMITS.workspaces) {
        const idle = [...this.contexts.values()].filter(value => !value.leases && !value.initializing && !value.context.watcher.isBusy).sort((a,b) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new Error('Workspace resource limit reached: all workspace slots are busy. Retry after active requests finish.');
        this.dispose(idle);
      }
      const config = ConfigLoader.load(undefined, root);
      const db = new SeptumDatabase(resolve(root, config.settings.db_path || '.septum/septum.db'));
      try {
        const repo = new SeptumRepository(db.raw);
        const pipeline = new IngestionPipeline(repo, root);
        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
        const abort = new AbortController();
        const ready = this.queue.run(async () => { abort.signal.throwIfAborted(); await pipeline.run(config, {verifyContent:true,signal:abort.signal}); });
        const watcher = new WorkspaceWatcher(root, repo, pipeline, ready, this.queue, this.budget, () => ConfigLoader.load(undefined, root));
        entry = {context:{root,config,db,repo,evaluator,pipeline,ready,watcher},leases:0,lastUsed:this.now(),initializing:true,abort};
        this.contexts.set(root, entry);
        const initialized = entry;
        void ready.then(() => { initialized.initializing = false; }, () => { initialized.initializing = false; this.dispose(initialized); });
      } catch (error) { db.close(); throw error; }
    }
    this.lastRoot = root;
    entry.leases++; entry.lastUsed = this.now();
    const leased = entry; let released = false;
    return {context: entry.context, release: () => { if (!released) { released=true; leased.leases--; leased.lastUsed=this.now(); } }};
  }

  private dispose(entry: Entry): Promise<void> {
    if (entry.disposal) return entry.disposal;
    if (this.contexts.get(entry.context.root) === entry) this.contexts.delete(entry.context.root);
    entry.abort.abort();
    const idle = !entry.leases && !entry.initializing && !entry.context.watcher.isBusy;
    const stop = entry.context.watcher.close();
    // Eviction of an idle context closes its database before admitting another.
    if (idle) entry.context.db.close();
    const disposal = stop.then(async () => { if (!idle) { await this.queue.drain(); entry.context.db.close(); } });
    entry.disposal = disposal;
    this.disposals.add(disposal);
    void disposal.finally(() => this.disposals.delete(disposal)).catch(error => console.error(`[Septum Cleanup Warning] ${String(error)}`));
    return disposal;
  }

  async expireIdle(): Promise<void> {
    const expired = [...this.contexts.values()].filter(entry => !entry.leases && !entry.initializing && !entry.context.watcher.isBusy && this.now() - entry.lastUsed >= RESOURCE_LIMITS.workspaceIdleMs);
    await Promise.all(expired.map(entry => this.dispose(entry)));
  }

  runTool<T>(work: () => Promise<T>): Promise<T> {
    return this.queue.run(() => { if (this.closed) throw new Error("Septum server is shutting down"); return work(); });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; clearInterval(this.idleTimer);
    const pending = [...this.contexts.values()].map(entry => this.dispose(entry));
    this.closing = Promise.allSettled([...pending, ...this.disposals, this.queue.drain()]).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
    return this.closing;
  }
}
