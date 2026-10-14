import { existsSync, lstatSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import type { ValidatedSeptumConfig } from '../core/config/schema.ts';
import type { SeptumRepository } from '../core/database/repository.ts';
import type { IngestionPipeline } from '../core/ingestion/pipeline.ts';
import { ASTParserEngine } from '../core/parser/tree-sitter.ts';
import { shouldIgnoreSourcePath } from '../core/resources/ignore.ts';
import { RESOURCE_LIMITS } from '../core/resources/limits.ts';
import { SerialWorkQueue } from '../core/resources/work-queue.ts';

export class WatchBudget {
  count = 0;
  constructor(private readonly limit = RESOURCE_LIMITS.watches) {}
  take(): boolean { if (this.count >= this.limit) return false; this.count++; return true; }
  release(): void { this.count--; }
}

export class WorkspaceWatcher {
  private watches = new Map<string, FSWatcher>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;
  private reconcile = false;
  private lastVerify = 0;
  private abort = new AbortController();
  private closing: Promise<void> | null = null;
  private config: ValidatedSeptumConfig;
  mode: 'native' | 'polling' = 'native';

  constructor(
    private readonly root: string,
    private readonly repo: SeptumRepository,
    private readonly pipeline: IngestionPipeline,
    private readonly ready: Promise<void>,
    private readonly queue: SerialWorkQueue,
    private readonly budget: WatchBudget,
    private readonly loadConfig: () => ValidatedSeptumConfig,
  ) {
    this.config = this.loadConfig();
    this.registerDirectories();
    // Periodic content verification also protects native watchers from missed events.
    this.poll = setInterval(() => { void this.flush(false).catch(error => this.recordError(error)); }, RESOURCE_LIMITS.pollMs);
    this.poll.unref();
  }

  get isBusy(): boolean { return this.flushing !== null; }
  get pendingCount(): number { return this.pending.size; }
  get watchCount(): number { return this.watches.size; }

  private recordError(error: unknown): void {
    if (!this.closed) this.repo.setMeta('sync_error', String(error));
  }

  private clearWatches(): void {
    for (const watcher of this.watches.values()) { watcher.close(); this.budget.release(); }
    this.watches.clear();
  }

  private fallback(error: unknown): void {
    this.clearWatches();
    this.mode = 'polling';
    this.repo.setMeta('watcher_mode', 'polling');
    console.error(`[Septum Watcher Warning] Using bounded polling: ${String(error)}`);
  }

  private registerDirectories(): void {
    if (this.closed || this.mode === 'polling') return;
    const config = this.loadConfig();
    this.config = config;
    const seen = new Set<string>();
    const stack = [this.root];
    const domainRoots = Object.values(config.domains || {})
      .map(d => relative(this.root, resolve(this.root, d.root)).replace(/\\/g, '/').replace(/^\/|\/$/g, ''))
      .filter(dr => dr !== '.' && dr !== '');
    try {
      while (stack.length) {
        const dir = stack.pop()!;
        const rel = relative(this.root, dir).replace(/\\/g, '/');
        if (rel && shouldIgnoreSourcePath(rel, config.settings.ignore_patterns)) continue;
        const stat = lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        seen.add(dir);
        if (!this.watches.has(dir)) {
          if (!this.budget.take()) throw new Error(`Native watch limit ${RESOURCE_LIMITS.watches} reached`);
          let watcher: FSWatcher;
          try {
            watcher = watch(dir, {recursive: false}, (_event, filename) => {
              if (filename) this.notify(relative(this.root, join(dir, String(filename))).replace(/\\/g, '/'));
              else { this.reconcile = true; this.schedule(); }
            });
          } catch (error) { this.budget.release(); throw error; }
          this.watches.set(dir, watcher);
          watcher.on('error', error => { if (!this.closed) { this.fallback(error); this.reconcile = true; this.schedule(); } });
        }
        for (const entry of readdirSync(dir, {withFileTypes: true})) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            const childDir = join(dir, entry.name);
            const childRel = relative(this.root, childDir).replace(/\\/g, '/');
            if (shouldIgnoreSourcePath(childRel, config.settings.ignore_patterns)) continue;
            if (domainRoots.length > 0) {
              const isRelevant = domainRoots.some(dr => childRel === dr || childRel.startsWith(dr + '/') || dr.startsWith(childRel + '/'));
              if (!isRelevant) continue;
            }
            stack.push(childDir);
          }
        }
      }
      for (const [dir, watcher] of this.watches) {
        if (!seen.has(dir)) { watcher.close(); this.watches.delete(dir); this.budget.release(); }
      }
      this.repo.setMeta('watcher_mode', 'native');
    } catch (error) { this.fallback(error); }
  }

  notify(filename: string): void {
    if (this.closed || this.reconcile) return;
    const norm = filename.replace(/\\/g, '/');
    const target = resolve(this.root, norm);
    const rel = relative(this.root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || shouldIgnoreSourcePath(norm, this.config.settings.ignore_patterns)) return;
    let directory = this.watches.has(target);
    try { directory ||= lstatSync(target).isDirectory(); } catch { /* deletion */ }
    if (directory || /(^|\/)(package\.json|composer\.json|nest-cli\.json|go\.mod|tsconfig\.json|artisan)$/.test(norm)) {
      this.reconcile = true;
      this.pending.clear();
    } else if (ASTParserEngine.isSourceFile(norm)) {
      if (this.pending.size >= RESOURCE_LIMITS.pendingPaths) { this.reconcile = true; this.pending.clear(); }
      else this.pending.add(norm);
    } else return;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(false).catch(error => this.recordError(error)); }, RESOURCE_LIMITS.debounceMs);
  }

  async flush(forceVerify = true): Promise<void> {
    if (this.closed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.flushing) {
      await this.flushing;
      if (forceVerify || this.pending.size || this.reconcile) return this.flush(forceVerify);
      return;
    }
    const verify = (forceVerify && this.mode === 'polling') || Date.now() - this.lastVerify >= RESOURCE_LIMITS.verifyMs;
    const poll = this.mode === 'polling';
    if (!poll && !verify && !this.reconcile && !this.pending.size && !this.repo.getMeta('sync_error')) return;
    this.flushing = this.queue.run(async () => {
      await this.ready;
      this.abort.signal.throwIfAborted();
      const config = this.loadConfig();
      if (poll || verify || this.reconcile || this.repo.getMeta('sync_error')) {
        this.reconcile = false;
        this.pending.clear();
        await this.pipeline.run(config, {verifyContent: verify, signal: this.abort.signal});
        if (verify) this.lastVerify = Date.now();
        this.registerDirectories();
      }
      let sourceEvents = false;
      while (this.pending.size) {
        sourceEvents = true;
        const paths = [...this.pending]; this.pending.clear();
        for (const filename of paths) {
          this.abort.signal.throwIfAborted();
          const target = resolve(this.root, filename);
          if (existsSync(target)) await this.pipeline.ingestFile(target, config);
          else this.repo.runInTransaction(() => {
            this.repo.deleteFileByPath(filename); this.repo.clearVerticalSlices(); this.repo.setMeta('slices_dirty', '1');
            const unsupported: string[] = JSON.parse(this.repo.getMeta('unsupported_files') || '[]');
            this.repo.setMeta('unsupported_files', JSON.stringify(unsupported.filter(path => path !== filename)));
            const skipped: {path: string; reason: string}[] = JSON.parse(this.repo.getMeta('skipped_files') || '[]');
            this.repo.setMeta('skipped_files', JSON.stringify(skipped.filter(file => file.path !== filename)));
          });
        }
      }
      if (sourceEvents || this.repo.getMeta('slices_dirty') === '1') await this.pipeline.run(config, {signal: this.abort.signal});
    });
    try { await this.flushing; }
    finally { this.flushing = null; }
    // A directory event during sync must not be lost behind the coalesced flush.
    if (!this.closed && (this.reconcile || this.pending.size)) await this.flush(false);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.clearWatches(); this.pending.clear();
    this.closing = Promise.allSettled([this.ready, this.flushing]).then(() => {});
    return this.closing;
  }
}
