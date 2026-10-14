"""Observe real init lifecycle on disposable fixtures, including PTY interaction.

Exit 0 means the audit completed, not that all observed init behaviors are safe.
Usage: python3 scripts/audit-init-lifecycle.py --output /tmp/septum-init-audit.json
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import pty
import runpy
import select
import shutil
import sqlite3
import subprocess
import tempfile
import time
import tomllib

PROJECT = Path(__file__).resolve().parents[1]
COMMON = runpy.run_path(str(PROJECT / 'scripts/audit-mcp-cli-contracts.py'))
CLI, ENV, cli, bun_eval = (COMMON[key] for key in ['SOURCE', 'ENV', 'cli', 'bun_eval'])
ENV.update({'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1'})


def file(root, name, text):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)
    return target


def git(root, *args):
    result = cli(['git'], root, *args)
    assert result['exit_code'] == 0, result
    return result


def fixture(base, name, with_git=False):
    root = base / name
    file(root, 'package.json', '{"name":"init-audit-fixture"}\n')
    file(root, 'src/orders/Order.ts', 'export function total() { return 1; }\n')
    file(root, 'src/billing/Invoice.ts', 'export function invoice() { return 1; }\n')
    if with_git:
        git(root, 'init', '-q')
    return root


def init(root, *args, keys=None):
    if keys is None:
        return cli(CLI, root, 'init', *args)
    # Both stdin and stdout must be TTY for the real selection UI.
    master, slave = pty.openpty()
    process = subprocess.Popen(CLI + ['init', *args], cwd=root, env=ENV,
                               stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    chunks, sent = [], False
    deadline = time.monotonic() + 20
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], .05)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                chunks.append(chunk)
            output = b''.join(chunks)
            if not sent and b'Select AI Agent Harnesses' in output:
                time.sleep(.05)  # Allow the rendered prompt to attach its key listener.
                os.write(master, keys)
                sent = True
            if process.poll() is not None:
                # Drain any final buffered output on the next iteration.
                if not select.select([master], [], [], 0)[0]:
                    break
        if process.poll() is None:
            process.kill()
            raise TimeoutError(f'init TTY did not finish: {root.name}')
        return {'args': ['init', *args], 'tty_keys_hex': keys.hex(), 'keys_sent': sent,
                'exit_code': process.wait(), 'stdout': b''.join(chunks).decode(errors='replace'), 'stderr': ''}
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        os.close(master)


def inspect(root):
    artifacts = {}
    for prefix in ['.mcp.json', '.gitignore', 'opencode.json', '.gemini', '.claude', '.codex', '.cursor', '.pi', '.goose', '.agents', '.husky']:
        target = root / prefix
        paths = [target] if target.is_file() else sorted(target.rglob('*')) if target.is_dir() else []
        for path in paths:
            if path.is_file():
                data = path.read_bytes()
                artifacts[str(path.relative_to(root))] = {
                    'sha256': hashlib.sha256(data).hexdigest(), 'mode': oct(path.stat().st_mode & 0o777),
                    'mtime_ns': path.stat().st_mtime_ns, 'text': data.decode(errors='replace')}
    state = {'artifacts': artifacts, 'agents_dir_exists': (root / '.agents').exists()}
    if (root / '.git').exists():
        hook = cli(['git'], root, 'rev-parse', '--git-path', 'hooks/pre-commit')
        state['git_hook_path'] = hook['stdout'].strip()
        candidates = {'installed_default': root / '.git/hooks/pre-commit'}
        if hook['exit_code'] == 0:
            candidates['active'] = root / hook['stdout'].strip()
        state['git_hooks'] = {key: {'path': str(path), 'text': path.read_text(), 'mode': oct(path.stat().st_mode & 0o777)}
                              for key, path in candidates.items() if path.is_file()}
    db_path = root / '.septum/septum.db'
    state['db_exists'] = db_path.exists()
    if db_path.exists():
        state['db_file_sha256'] = hashlib.sha256(db_path.read_bytes()).hexdigest()
        connection = None
        try:
            connection = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
            connection.row_factory = sqlite3.Row
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            state['db'] = {}
            for table in ['domains', 'repo_meta', 'files', 'symbols', 'environment_topology', 'environment_nodes']:
                if table in tables:
                    state['db'][table] = [dict(row) for row in connection.execute(f'SELECT * FROM {table}')]
        except sqlite3.DatabaseError as error:
            state['db_error'] = str(error)
        finally:
            if connection:
                connection.close()
    return state


def update_meta(root, key, value):
    connection = sqlite3.connect(root / '.septum/septum.db')
    try:
        connection.execute('INSERT OR REPLACE INTO repo_meta(key,value) VALUES (?,?)', (key, value))
        connection.commit()
    finally:
        connection.close()


def fake_hook_runtimes(root, global_code=1, local_code=0):
    fake = root / 'fake-bin'
    log = root / 'hook-invocations.log'
    for name, code in [('septum', global_code), ('bunx', 0), ('bun', 1)]:
        path = file(root, f'fake-bin/{name}', f'#!/bin/sh\nprintf "%s\\n" "{name}:$*" >> "{log}"\nexit {code}\n')
        path.chmod(0o755)
    path = file(root, 'node_modules/.bin/septum', f'#!/bin/sh\nprintf "%s\\n" "local:$*" >> "{log}"\nexit {local_code}\n')
    path.chmod(0o755)
    return {**ENV, 'PATH': f'{fake}:/usr/bin:/bin'}, log


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source_paths = [PROJECT / 'package.json', PROJECT / 'bin/septum.ts', *sorted((PROJECT / 'src').rglob('*.ts'))]
    evidence = {'generated_at': datetime.now(timezone.utc).isoformat(), 'project': str(PROJECT),
                'source_sha256': {str(path.relative_to(PROJECT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in source_paths},
                'cases': {}}
    with tempfile.TemporaryDirectory(prefix='septum-init-audit-') as temporary:
        base = Path(temporary)

        def record(name, root, *init_args, keys=None):
            print(f'Probing {name}', flush=True)
            before = inspect(root)
            run = init(root, *init_args, keys=keys)
            evidence['cases'][name] = {'cwd': str(root), 'before': before, 'run': run, 'after': inspect(root)}
            return evidence['cases'][name]

        fresh = fixture(base, 'fresh-non-git')
        record('fresh_non_git', fresh)
        record('repeat_unmodified', fresh)

        normal = fixture(base, 'fresh-git', True)
        record('fresh_git', normal)
        record('repeat_git', normal)

        custom = fixture(base, 'custom-git', True)
        file(custom, '.git/hooks/pre-commit', '#!/bin/sh\necho USER_EXISTING_CHECK\nexit 23\n').chmod(0o755)
        file(custom, '.mcp.json', json.dumps({'user_setting': True, 'mcpServers': {'other': {'command': 'keep'}, 'septum': {'command': 'user-septum', 'args': ['custom']}}}))
        file(custom, '.claude/settings.json', json.dumps({'custom': 42, 'hooks': {'PreToolUse': [{'matcher': 'Read', 'hooks': [{'type': 'command', 'command': 'user-hook'}]}]}}))
        file(custom, '.gemini/hooks.json', json.dumps({'user-custom-hook': {'enabled': True}, 'septum-boundary-guard': {'user_override': True}}))
        file(custom, '.gemini/skills/septum-map/SKILL.md', 'USER_CUSTOM_SKILL')
        file(custom, '.gemini/rules/septum-boundary.md', 'USER_CUSTOM_RULE')
        file(custom, '.gemini/hooks/septum-pre-write.sh', '#!/bin/sh\necho USER_CUSTOM_SHARED_SCRIPT\n')
        force_custom = base / 'custom-git-force-matched'
        shutil.copytree(custom, force_custom)
        record('existing_user_artifacts', custom)
        record('force_matched_user_artifacts', force_custom, '--force')
        record('force_existing_artifacts', custom, '--force')

        db_custom = fixture(base, 'custom-domain-config')
        for name in ['core', 'types', 'cli']:
            file(db_custom, f'src/{name}/value.ts', f'export const {name}Value = 1;\n')
        record('custom_domain_setup', db_custom)
        file(db_custom, 'manual/core/value.ts', 'export const manualValue = 1;\n')
        bun_eval(db_custom, """const db=new SeptumDatabase(); const repo=new SeptumRepository(db.raw);
          repo.upsertDomain('core',{root:'manual/core',allowed_dependencies:['billing'],forbidden_dependencies:['orders'],archetypes:{widget:'*.ts'}});
          repo.upsertDomain('user-domain',{root:'manual/core',allowed_dependencies:['billing']});
          repo.setMeta('settings_json',JSON.stringify({enforcement:'strict'}));
          repo.setMeta('features_json',JSON.stringify({userFeature:{domain:'core',allowed_touchpoints:['manual/core/value.ts']}}));
          repo.environment.saveLayer({layer:'host',platform:'User VPS',status:'VERIFIED',constraints:['USER_CONSTRAINT'],detected_from:['manual']});db.close();""")
        record('repeat_custom_domains', db_custom)
        record('force_custom_domains', db_custom, '--force')

        hooks_path = fixture(base, 'custom-hooks-path', True)
        file(hooks_path, '.custom-hooks/pre-commit', '#!/bin/sh\necho ACTIVE_USER_HOOK\n').chmod(0o755)
        git(hooks_path, 'config', 'core.hooksPath', '.custom-hooks')
        record('core_hooks_path', hooks_path)

        commented_ignore = fixture(base, 'commented-gitignore', True)
        file(commented_ignore, '.gitignore', '# .septum/\n# .septum/*.db*\nuser.env\n')
        record('commented_gitignore', commented_ignore)
        evidence['commented_gitignore_check'] = cli(['git'], commented_ignore, 'check-ignore', '.septum/septum.db')

        husky = fixture(base, 'husky', True)
        file(husky, '.husky/pre-commit', '#!/bin/sh\necho USER_HUSKY_HOOK\n').chmod(0o755)
        record('husky_append', husky)
        record('husky_repeat', husky)
        hook_env, log = fake_hook_runtimes(husky)
        run = subprocess.run(['sh', str(husky / '.husky/pre-commit')], cwd=husky, env=hook_env, capture_output=True, text=True, timeout=5)
        evidence['husky_execution'] = {'exit_code': run.returncode, 'stdout': run.stdout, 'stderr': run.stderr, 'invocations': log.read_text() if log.exists() else ''}

        # Real linked worktree; both common Git directory and checkout are disposable.
        main_root = fixture(base, 'worktree-main', True)
        git(main_root, 'config', 'user.name', 'Init audit')
        git(main_root, 'config', 'user.email', 'init-audit@example.invalid')
        git(main_root, 'add', 'src', 'package.json')
        git(main_root, 'commit', '-qm', 'fixture baseline')
        linked = base / 'linked-worktree'
        git(main_root, 'worktree', 'add', '--detach', str(linked), 'HEAD')
        record('linked_worktree', linked)

        malformed = fixture(base, 'malformed-json')
        file(malformed, '.mcp.json', '{ USER_MALFORMED_JSON')
        file(malformed, '.claude/settings.json', '{ USER_MALFORMED_SETTINGS')
        record('malformed_json', malformed)

        bad_shape = fixture(base, 'wrong-json-shape')
        file(bad_shape, '.mcp.json', '"USER_STRING_CONFIG"')
        record('wrong_json_shape', bad_shape)

        bad_db = fixture(base, 'corrupt-db')
        file(bad_db, '.septum/septum.db', 'USER_CORRUPT_DATABASE')
        record('corrupt_database', bad_db)
        record('force_corrupt_database', bad_db, '--force')

        bad_meta = fixture(base, 'ingestion-config-error')
        bun_eval(bad_meta, "const db=new SeptumDatabase(); const repo=new SeptumRepository(db.raw); repo.setMeta('features_json','{bad feature JSON');db.close();")
        record('ingestion_config_error', bad_meta)

        failure = fixture(base, 'ingestion-pipeline-error')
        # Deterministic failure inside pipeline.run, after sync_state='running'.
        bun_eval(failure, "const db=new SeptumDatabase(); const repo=new SeptumRepository(db.raw);repo.setMeta('settings_json',JSON.stringify({ignore_patterns:[null]}));db.close();")
        record('ingestion_pipeline_error', failure)

        incomplete = fixture(base, 'incomplete-index')
        file(incomplete, 'src/orders/Unsupported.rs', 'pub fn unsupported() {}\n')
        file(incomplete, 'src/orders/Oversized.ts', '/*' + 'x' * (2 * 1024 * 1024) + '*/\n')
        record('unsupported_and_oversized_sources', incomplete)

        failed_scaffold = fixture(base, 'scaffold-path-error', True)
        file(failed_scaffold, '.claude', 'USER_FILE_BLOCKS_DIRECTORY')
        record('scaffold_path_error', failed_scaffold)

        # Generated Git hook behavior with real CLI and a forbidden staged import.
        file(normal, 'src/orders/Order.ts', "import {invoice} from '../billing/Invoice';\nexport const total=invoice();\n")
        bun_eval(normal, "const db=new SeptumDatabase();db.raw.query('UPDATE domains SET forbidden_deps_json=? WHERE name=?').run('[\"billing\"]','orders');db.close();")
        git(normal, 'add', 'src')
        evidence['git_hook_warn'] = cli(['sh', str(normal / '.git/hooks/pre-commit')], normal)
        update_meta(normal, 'settings_json', '{"enforcement":"strict"}')
        evidence['git_hook_strict'] = cli(['sh', str(normal / '.git/hooks/pre-commit')], normal)

        try:
            tty_default = fixture(base, 'tty-default')
            record('tty_default', tty_default, keys=b'\r')
            tty_none = fixture(base, 'tty-none')
            record('tty_none', tty_none, keys=b'aa\r')
            tty_all = fixture(base, 'tty-all')
            record('tty_all', tty_all, keys=b'a\r')
            tty_cancel = fixture(base, 'tty-cancel')
            record('tty_cancel', tty_cancel, keys=b'\x03')
            malformed_all = fixture(base, 'tty-malformed-all')
            file(malformed_all, '.codex/config.toml', '# [mcp_servers.septum]\nmodel = "user-model"\n')
            file(malformed_all, '.goose/config.yaml', 'extensions: [ USER_INVALID_YAML')
            case = record('tty_all_existing_config', malformed_all, keys=b'a\r')
            try:
                case['parsed_codex_config'] = tomllib.loads((malformed_all / '.codex/config.toml').read_text())
            except tomllib.TOMLDecodeError as error:
                case['codex_parse_error'] = str(error)
        except PermissionError as error:
            evidence['tty_unavailable'] = str(error)

        evidence['template_tests'] = cli(['bun', 'test', str(PROJECT / 'tests/unit/init-scaffold.test.ts')], fresh)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + '\n')
    assert evidence['template_tests']['exit_code'] == 0, evidence['template_tests']['stderr']
    assert evidence['cases']['fresh_non_git']['run']['exit_code'] == 0
    assert len(evidence['cases']['fresh_non_git']['after']['db']['files']) == 2
    if 'tty_none' in evidence['cases']:
        assert evidence['cases']['tty_none']['run']['exit_code'] == 0
        assert '.mcp.json' not in evidence['cases']['tty_none']['after']['artifacts']
        assert evidence['cases']['tty_cancel']['run']['exit_code'] == 130
    print(f'Audit observations saved: {args.output}; {len(evidence["cases"])} init runs')


if __name__ == '__main__':
    main()
