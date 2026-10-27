import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SeptumDatabase } from '../../src/core/database/client.ts';
import { SeptumRepository } from '../../src/core/database/repository.ts';
import { SeptumConfigSchema } from '../../src/core/config/schema.ts';
import { BoundaryEvaluator } from '../../src/core/boundary/evaluator.ts';
import { ModuleResolver } from '../../src/core/resolver/module-resolver.ts';
import { auditStagedFiles } from '../../src/core/boundary/staged-auditor.ts';
import { SEPTUM_PRE_WRITE_SCRIPT } from '../../src/cli/templates/hooks.ts';

const cli = resolve(import.meta.dir, '../../bin/septum.ts');
const run = (cwd: string, args: string[], env: Record<string, string> = {}) => Bun.spawnSync(['bun', 'run', cli, ...args], { cwd, env: { ...process.env, ...env }, timeout: 30_000 });
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd });

describe('CLI workspace root regressions', () => {
  it('init, sync, and check stay in markerless cwd despite ancestor DB and root env vars', () => {
    const parent = mkdtempSync(join(tmpdir(), 'septum-nested-root-'));
    try {
      const child = join(parent, 'workspace'); mkdirSync(join(child, 'src'), { recursive: true });
      writeFileSync(join(child, 'src/index.ts'), 'export const local = true;\n');
      mkdirSync(join(parent, '.septum'), { recursive: true });
      writeFileSync(join(parent, '.septum/septum.db'), 'ancestor must remain untouched');
      const before = readFileSync(join(parent, '.septum/septum.db'));
      const env = { SEPTUM_WORKSPACE_ROOT: parent, WORKSPACE_ROOT: parent };
      for (const args of [['init'], ['sync', '--json'], ['check', '--json']]) {
        const result = run(child, args, env);
        expect(result.exitCode).toBe(0);
        expect(readFileSync(join(parent, '.septum/septum.db'))).toEqual(before);
      }
      expect(readFileSync(join(child, '.septum/septum.db')).length).toBeGreaterThan(0);
      const db = new SeptumDatabase(join(child, '.septum/septum.db'));
      try { expect(db.raw.query("SELECT path FROM files").all()).toContainEqual({ path: 'src/index.ts' }); }
      finally { db.close(); }
      const cachedTarget = join(parent, 'cached-target'); mkdirSync(join(cachedTarget, 'src'), { recursive: true });
      writeFileSync(join(cachedTarget, 'src/cached.ts'), 'export const cached = true;\n');
      const resolver = resolve(import.meta.dir, '../../src/core/resolver/path-resolver.ts');
      const syncModule = resolve(import.meta.dir, '../../src/cli/commands/sync.ts');
      const cached = Bun.spawnSync(['bun', '-e', `import { setLastKnownProjectRoot } from '${resolver}'; import { handleSyncCommand } from '${syncModule}'; setLastKnownProjectRoot('${parent}'); await handleSyncCommand({ json: true });`], {
        cwd: cachedTarget, env: { ...process.env, SEPTUM_WORKSPACE_ROOT: '', WORKSPACE_ROOT: '' }, timeout: 30_000,
      });
      expect(cached.exitCode).toBe(0);
      expect(readFileSync(join(parent, '.septum/septum.db'))).toEqual(before);
      expect(readFileSync(join(cachedTarget, '.septum/septum.db')).length).toBeGreaterThan(0);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 60_000);

  it('nested staged audit ignores sibling changes and reads workspace blobs from Git root', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'septum-staged-nested-'));
    const workspace = join(parent, 'workspace');
    try {
      mkdirSync(join(workspace, 'src'), { recursive: true }); mkdirSync(join(parent, 'sibling'), { recursive: true });
      git(parent, 'init', '-q');
      mkdirSync(join(workspace, 'lib'), { recursive: true });
      writeFileSync(join(workspace, 'src/local.ts'), 'export const local = true;\n');
      writeFileSync(join(workspace, 'lib/util.ts'), 'export const util = true;\n');
      writeFileSync(join(parent, 'sibling/removed.ts'), 'export const sibling = true;\n');
      git(parent, 'add', '.'); git(parent, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
      writeFileSync(join(workspace, 'src/local.ts'), "import { util } from '../lib/util'; export const changed = util;\n");
      rmSync(join(parent, 'sibling/removed.ts'));
      git(parent, 'add', '-A');
      writeFileSync(join(workspace, 'src/local.ts'), 'export const changed = true;\n');
      const db = new SeptumDatabase(':memory:'); const repo = new SeptumRepository(db.raw);
      try {
        repo.upsertDomain('app', { root: 'src', forbidden_dependencies: ['lib'] });
        repo.upsertDomain('lib', { root: 'lib' });
        const config = SeptumConfigSchema.parse({ domains: { app: { root: 'src', forbidden_dependencies: ['lib'] }, lib: { root: 'lib' } }, features: { edit: { domain: 'app', allowed_touchpoints: ['src/**'] } } });
        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(workspace, repo));
        const result = await auditStagedFiles(evaluator, config, workspace, 'edit', repo);
        expect(result.files).toEqual(['src/local.ts']);
        expect(result.violations.some(violation => violation.rule === 'forbidden_dependency')).toBe(true);
      } finally { db.close(); }
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('generated lifecycle script resolves workspace from its own location when invoked elsewhere', () => {
    const parent = mkdtempSync(join(tmpdir(), 'septum-hook-root-'));
    try {
      const workspace = join(parent, 'workspace with spaces'); const hooks = join(workspace, '.codex/hooks'); const outside = join(parent, 'elsewhere');
      mkdirSync(hooks, { recursive: true }); mkdirSync(outside); mkdirSync(join(workspace, '.septum'));
      writeFileSync(join(workspace, '.septum/septum.db'), 'fixture');
      mkdirSync(join(workspace, 'bin'), { recursive: true }); writeFileSync(join(workspace, 'bin/septum.ts'), '');
      const script = join(hooks, 'septum-pre-write.sh'); writeFileSync(script, SEPTUM_PRE_WRITE_SCRIPT);
      const fakeBin = join(parent, 'bin'); mkdirSync(fakeBin);
      const capture = join(parent, 'capture');
      writeFileSync(join(fakeBin, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > '${capture}'\n`, { mode: 0o755 });
      const result = Bun.spawnSync(['sh', script], { cwd: outside, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(capture, 'utf8')).toContain(workspace);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
