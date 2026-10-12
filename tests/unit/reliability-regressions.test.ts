import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SeptumDatabase } from '../../src/core/database/client.ts';
import { SeptumRepository } from '../../src/core/database/repository.ts';
import { SeptumConfigSchema } from '../../src/core/config/schema.ts';
import { ConfigLoader } from '../../src/core/config/loader.ts';
import { BoundaryEvaluator } from '../../src/core/boundary/evaluator.ts';
import { ModuleResolver } from '../../src/core/resolver/module-resolver.ts';
import { IngestionPipeline } from '../../src/core/ingestion/pipeline.ts';
import { ASTParserEngine } from '../../src/core/parser/tree-sitter.ts';
import { SessionManager } from '../../src/core/session/session-manager.ts';
import { handleRegisterFeature } from '../../src/mcp/tools/register-feature.ts';
import { auditStagedFiles } from '../../src/core/boundary/staged-auditor.ts';
import { VerticalSliceTracer } from '../../src/core/resolver/vertical-slice-tracer.ts';

const roots: string[] = [];
const databases: SeptumDatabase[] = [];
function project() {
  const root = mkdtempSync('/tmp/septum-regression-'); roots.push(root);
  writeFileSync(join(root, 'package.json'), '{}');
  const db = new SeptumDatabase(join(root, '.septum/septum.db')); databases.push(db);
  return { root, db, repo: new SeptumRepository(db.raw) };
}
function file(root: string, path: string, content: string) {
  mkdirSync(resolve(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}
const cli = resolve(import.meta.dir, '../../bin/septum.ts');
function command(root: string, args: string[], input?: string) {
  return Bun.spawnSync(['bun', 'run', cli, ...args], { cwd: root, stdin: input ? Buffer.from(input) : undefined });
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Reliability regressions', () => {
  it('limits folder touchpoints to normalized directory boundaries', () => {
    const { root, repo } = project();
    const config = SeptumConfigSchema.parse({ domains: { orders: { root: 'src/orders' } }, features: { edit: { domain: 'orders', allowed_touchpoints: ['src/orders/controllers/**'] } } });
    const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
    expect(evaluator.checkFeatureTouchpoints('edit', 'src/orders/controllers/Order.ts', config)).toHaveLength(0);
    for (const path of ['src/orders/controllers-other/Secret.ts', 'src/orders/controllers/../Secret.ts', join(root, 'src/orders/controllers-other/Secret.ts')]) {
      expect(evaluator.checkFeatureTouchpoints('edit', path, config)).toHaveLength(1);
    }
    expect(evaluator.checkFeatureTouchpoints('edit', join(root, 'src/orders/controllers/Order.ts'), config)).toHaveLength(0);
    config.features.edit.allowed_touchpoints = ['src/orders/controllers/*'];
    expect(evaluator.checkFeatureTouchpoints('edit', 'src/orders/controllers/nested/Order.ts', config)).toHaveLength(1);
  });

  it('loads persisted feature rules before a separate hook checks scope', async () => {
    const { root, repo } = project();
    const config = SeptumConfigSchema.parse({ domains: { orders: { root: 'src/orders' } } });
    repo.upsertDomain('orders', config.domains.orders);
    await handleRegisterFeature(repo, config, { feature_key: 'edit', domain: 'orders', allowed_touchpoints: ['src/orders/allowed.ts'] }, root);
    writeFileSync(join(root, '.septum/catalog_access.json'), JSON.stringify({ domains: { orders: new Date().toISOString() } }));
    expect(ConfigLoader.load(undefined, root).features.edit).toBeDefined();
    const result = command(root, ['hook', 'pre-write'], JSON.stringify({ tool_input: { file_path: 'src/orders/outside.ts', content: 'export const value=1;' } }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('Scope Touchpoint Lock');
  });

  it('strict CLI checks disallowed imports before deciding the exit code', async () => {
    const { root, repo } = project();
    const config = SeptumConfigSchema.parse({ domains: { orders: { root: 'src/orders' }, billing: { root: 'src/billing' } } });
    file(root, 'src/orders/Order.ts', "import { invoice } from '../billing/Invoice';\nexport const order=invoice;\n");
    file(root, 'src/billing/Invoice.ts', 'export const invoice=1;\n');
    await new IngestionPipeline(repo, root).run(config);
    expect(command(root, ['check', '--strict']).exitCode).toBe(1);
  });

  it('checks the Git index even when unstaged content removed the forbidden import', () => {
    const { root, repo } = project();
    repo.upsertDomain('orders', { root: 'src/orders', forbidden_dependencies: ['billing'] });
    repo.upsertDomain('billing', { root: 'src/billing' });
    file(root, 'src/orders/Order.ts', "import { invoice } from '../billing/Invoice';\nexport const order=invoice;\n");
    file(root, 'src/billing/Invoice.ts', 'export const invoice=1;\n');
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync(['git', 'add', 'src'], { cwd: root }).exitCode).toBe(0);
    file(root, 'src/orders/Order.ts', 'export const order=1;\n');
    const result = command(root, ['check', '--staged', '--strict']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('FORBIDDEN_DEPENDENCY');
  });

  it('keeps the most specific domain in single-file ingestion', async () => {
    const { root, repo } = project();
    const config = SeptumConfigSchema.parse({ domains: { app: { root: 'src' }, billing: { root: 'src/billing' } } });
    file(root, 'src/billing/Invoice.ts', 'export const invoice=1;\n');
    const pipeline = new IngestionPipeline(repo, root); await pipeline.run(config);
    file(root, 'src/billing/Invoice.ts', 'export const changedInvoice=100;\n'); await pipeline.ingestFile(join(root, 'src/billing/Invoice.ts'), config);
    expect(repo.getFileWithDomain('src/billing/Invoice.ts')?.domain_name).toBe('billing');
    expect(new ModuleResolver(root, repo).resolveSourceDomain('src/billing/Invoice.ts', config)).toBe('billing');
  });

  it('invalidates old NestJS routes when a controller is reindexed', async () => {
    const { root, repo } = project();
    writeFileSync(join(root, 'nest-cli.json'), '{}');
    const source = (route: string) => `@Controller('orders')\nexport class OrdersController {\n @Get('${route}')\n list() {}\n}`;
    file(root, 'src/orders.controller.ts', source('old'));
    const config = SeptumConfigSchema.parse({ domains: { app: { root: 'src' } } });
    const pipeline = new IngestionPipeline(repo, root); await pipeline.run(config);
    file(root, 'src/orders.controller.ts', source('new')); await pipeline.ingestFile(join(root, 'src/orders.controller.ts'), config);
    const tracer = new VerticalSliceTracer(repo, root);
    expect(tracer.trace('GET /orders/new').found).toBe(true);
    expect(tracer.trace('GET /orders/old').found).toBe(false);
  });

  it('does not label an unknown symbol as low risk', () => {
    const { repo } = project();
    const result = repo.getSymbolImpact('MissingService');
    expect(result.found_in_index).toBe(false);
    expect(result.impact_summary.risk_level).toBe('unknown');
  });

  it('reports unsupported languages rather than a successful empty parse', async () => {
    const parser = new ASTParserEngine();
    for (const [path, source] of [['hello.rs', 'pub fn hello() {}'], ['Hello.java', 'class Hello {}'], ['Hello.cs', 'class Hello {}'], ['hello.rb', 'def hello\nend']]) {
      expect((await parser.parseFile(path, source) as any).status).toBe('unsupported');
    }
  });

  it('rejects acquisition and clearing by a different session owner', () => {
    const { root } = project();
    const session = { feature_key: 'edit', domain: 'orders', touchpoints: ['src/orders/allowed.ts'], locked_at: new Date().toISOString() };
    (SessionManager.saveActiveSession as any)(root, session, 'agent-A');
    expect(() => (SessionManager.saveActiveSession as any)(root, session, 'agent-B')).toThrow();
    expect(() => (SessionManager.clearActiveSession as any)(root, 'agent-B')).toThrow();
    expect(SessionManager.getActiveSession(root)?.feature_key).toBe('edit');
    expect((SessionManager.clearActiveSession as any)(root, 'agent-A')).toBe(true);
  });
});

describe('Distributed parser assets', () => {
  it('detects forbidden multiline imports in a standalone executable', () => {
    const { root, repo } = project();
    repo.upsertDomain('orders', { root: 'src/orders', forbidden_dependencies: ['billing'] });
    repo.upsertDomain('billing', { root: 'src/billing' });
    file(root, 'src/orders/Order.ts', "import {\n invoice\n} from '../billing/Invoice';\nexport const order=invoice;\n");
    file(root, 'src/billing/Invoice.ts', 'export const invoice=1;\n');
    const binary = join(root, 'septum');
    const build = Bun.spawnSync(['bun', 'build', cli, '--compile', '--outfile', binary]);
    expect(build.exitCode).toBe(0);
    const check = Bun.spawnSync([binary, 'check', '--strict'], { cwd: root });
    expect(check.exitCode).toBe(1);
    expect(check.stderr.toString()).toContain('FORBIDDEN_DEPENDENCY');
  });
});

describe('Audit completeness', () => {
  it('refuses a clean audit when mapped source files have no supported parser', () => {
    const { root, repo } = project();
    repo.upsertDomain('app', { root: 'src' });
    file(root, 'src/hello.rs', 'pub fn hello() {}');
    const result = command(root, ['check', '--strict']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('unsupported');
  });

  it('supports domain-relative folder scopes with the same directory limits', () => {
    const { root, repo } = project();
    const config = SeptumConfigSchema.parse({ domains: { orders: { root: 'src/orders' } }, features: { edit: { domain: 'orders', allowed_touchpoints: ['controllers/**'] } } });
    const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
    expect(evaluator.checkFeatureTouchpoints('edit', 'src/orders/controllers/Order.ts', config)).toHaveLength(0);
    expect(evaluator.checkFeatureTouchpoints('edit', 'src/orders/controllers-other/Order.ts', config)).toHaveLength(1);
  });

  it('enforces the active session even when the payload tries another feature', async () => {
    const { root, repo } = project();
    const config = SeptumConfigSchema.parse({ domains: { orders: { root: 'src/orders' } } });
    repo.upsertDomain('orders', config.domains.orders);
    await handleRegisterFeature(repo, config, { feature_key: 'locked', domain: 'orders', allowed_touchpoints: ['src/orders/allowed.ts'] }, root);
    repo.setMeta('features_json', JSON.stringify({ ...config.features, other: { ...config.features.locked, allowed_touchpoints: ['src/orders/outside.ts'] } }));
    writeFileSync(join(root, '.septum/catalog_access.json'), JSON.stringify({ domains: { orders: new Date().toISOString() } }));
    const result = command(root, ['hook', 'pre-write'], JSON.stringify({ tool_input: { feature_key: 'other', file_path: 'src/orders/outside.ts', content: 'export const value=1;' } }));
    expect(result.exitCode).toBe(1);
  });
});

describe('Domain reconciliation', () => {
  it('normalizes parent roots before excluding a nested domain', async () => {
    const { root, repo } = project();
    const config = SeptumConfigSchema.parse({ domains: { billing: { root: 'src/billing' }, app: { root: 'src/' } } });
    file(root, 'src/billing/Invoice.ts', 'export const invoice=1;');
    await new IngestionPipeline(repo, root).run(config);
    expect(repo.getFileWithDomain('src/billing/Invoice.ts')?.domain_name).toBe('billing');
  });

  it('prunes indexed files when an entire domain directory disappears', async () => {
    const { root, repo } = project();
    const config = SeptumConfigSchema.parse({ domains: { billing: { root: 'src/billing' } } });
    file(root, 'src/billing/Invoice.ts', 'export const invoice=1;');
    const pipeline = new IngestionPipeline(repo, root);
    await pipeline.run(config);
    rmSync(join(root, 'src/billing'), { recursive: true });
    await pipeline.run(config);
    expect(repo.getFileByPath('src/billing/Invoice.ts')).toBeNull();
  });

  it('refuses corrupt stored boundary rules instead of loading a partial config', () => {
    const { repo } = project();
    repo.upsertDomain('billing', { root: 'src/billing' });
    repo.runInTransaction(() => {
      const db = databases[databases.length - 1];
      db.raw.query('UPDATE domains SET forbidden_deps_json=?').run('invalid-json');
    });
    expect(() => ConfigLoader.loadFromRepository(repo)).toThrow();
  });
});


it('rejects circular dependencies between staged files', async () => {
  const { root, repo } = project();
  const config = SeptumConfigSchema.parse({ domains: { a: { root: 'src/a', allowed_dependencies: ['b'] }, b: { root: 'src/b', allowed_dependencies: ['a'] } } });
  file(root, 'src/a/A.ts', "import {b} from '../b/B';\nexport const a=b;\n");
  file(root, 'src/b/B.ts', "import {a} from '../a/A';\nexport const b=a;\n");
  await new IngestionPipeline(repo, root).run(config);
  expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0);
  expect(Bun.spawnSync(['git', 'add', 'src'], { cwd: root }).exitCode).toBe(0);
  const result = await auditStagedFiles(new BoundaryEvaluator(repo, new ModuleResolver(root, repo)), config, root);
  expect(result.violations.some(violation => violation.rule === 'circular_dependency')).toBe(true);
});


it('verifies a changed file even when an editor preserves size and mtime', async () => {
  const { root, repo } = project();
  const config = SeptumConfigSchema.parse({ domains: { app: { root: 'src' } } });
  const source = 'src/hello.ts';
  file(root, source, 'export function first() {}');
  const pipeline = new IngestionPipeline(repo, root);
  await pipeline.run(config);
  const oldStat = statSync(join(root, source));
  file(root, source, 'export function other() {}');
  utimesSync(join(root, source), oldStat.atime, oldStat.mtime);
  const record = repo.getFileByPath(source)!;
  const currentStat = statSync(join(root, source));
  repo.updateFileMetadataOnly(record.id, currentStat.mtimeMs, currentStat.size);
  expect(await pipeline.ingestFile(join(root, source), config)).toBe(true);
  const names = repo.getAllSymbolsWithFiles().map(symbol => symbol.name);
  expect(names).toContain('other');
  expect(names).not.toContain('first');
});

async function committedCycle() {
  const fixture = project();
  const config = SeptumConfigSchema.parse({ domains: { a: { root: 'src/a', allowed_dependencies: ['b'] }, b: { root: 'src/b', allowed_dependencies: ['a'] } } });
  file(fixture.root, 'src/a/A.ts', "import {b} from '../b/B';\nexport const a=b;\n");
  file(fixture.root, 'src/b/B.ts', "import {a} from '../a/A';\nexport const b=a;\n");
  await new IngestionPipeline(fixture.repo, fixture.root).run(config);
  for (const args of [['init', '-q'], ['add', 'src'], ['-c', 'user.name=Regression', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']]) {
    expect(Bun.spawnSync(['git', ...args], { cwd: fixture.root }).exitCode).toBe(0);
  }
  return { ...fixture, config, evaluator: new BoundaryEvaluator(fixture.repo, new ModuleResolver(fixture.root, fixture.repo)) };
}

it('does not reject unrelated baseline cycles during a staged check', async () => {
  const { root, repo, config, evaluator } = await committedCycle();
  file(root, 'src/a/C.ts', 'export const unrelated=1;');
  expect(Bun.spawnSync(['git', 'add', 'src/a/C.ts'], { cwd: root }).exitCode).toBe(0);
  const result = await auditStagedFiles(evaluator, config, root, undefined, repo);
  expect(result.violations).toHaveLength(0);
});

it('removes deleted dependency edges from the staged cycle graph', async () => {
  const { root, repo, config, evaluator } = await committedCycle();
  rmSync(join(root, 'src/b/B.ts'));
  file(root, 'src/a/A.ts', "import {b} from '../b/B';\nexport const a=b;\nexport const extra=1;\n");
  expect(Bun.spawnSync(['git', 'add', '-u'], { cwd: root }).exitCode).toBe(0);
  const result = await auditStagedFiles(evaluator, config, root, undefined, repo);
  expect(result.violations.some(violation => violation.rule === 'circular_dependency')).toBe(false);
});
