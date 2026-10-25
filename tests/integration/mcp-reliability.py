"""Exercise a real stdio server; fixtures and subprocesses are always cleaned up."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[2]
CLI = PROJECT / 'bin/septum.ts'

def bun_eval(code, root):
    subprocess.run(['bun', '-e', code], cwd=root, check=True, capture_output=True, text=True)

def setup(base, name):
    root = base / name
    (root / 'src/orders').mkdir(parents=True)
    (root / 'src/billing').mkdir(parents=True)
    (root / 'package.json').write_text('{}')
    (root / 'src/orders/Order.ts').write_text('export function oldOrder() {}\n')
    (root / 'src/orders/Other.ts').write_text('export function oldOther() {}\n')
    (root / 'src/billing/Invoice.ts').write_text('export function invoice() {}\n')
    bun_eval(f'''import {{SeptumDatabase}} from {json.dumps(str(PROJECT / 'src/core/database/client.ts'))};
      import {{SeptumRepository}} from {json.dumps(str(PROJECT / 'src/core/database/repository.ts'))};
      const db=new SeptumDatabase('.septum/septum.db'); const repo=new SeptumRepository(db.raw);
      repo.upsertDomain('orders',{{root:'src/orders',allowed_dependencies:['billing']}});
      repo.upsertDomain('billing',{{root:'src/billing'}}); db.close();''', root)
    subprocess.run(['bun', 'run', str(CLI), 'sync'], cwd=root, check=True, capture_output=True)
    return root

with tempfile.TemporaryDirectory(prefix='septum-mcp-regression-') as temporary:
    a = setup(Path(temporary), 'a')
    b = setup(Path(temporary), 'b')
    server = subprocess.Popen(['bun', 'run', str(CLI), 'serve'], cwd=a,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True)
    selector = selectors.DefaultSelector()
    selector.register(server.stdout, selectors.EVENT_READ)
    serial = 0

    def request(method, params):
        global serial
        serial += 1
        server.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': serial, 'method': method, 'params': params}) + '\n')
        server.stdin.flush()
        if not selector.select(5):
            raise AssertionError(f'RPC timeout: {method}')
        response = json.loads(server.stdout.readline())
        assert 'error' not in response, response
        return response['result']

    def tool(name, args):
        result = request('tools/call', {'name': name, 'arguments': args})
        assert not result.get('isError'), result
        return json.loads(result['content'][0]['text'])

    def wait_symbols(root, expected):
        deadline = time.monotonic() + 5
        while True:
            catalog = tool('septum_domain', {'action': 'catalog', 'domain': 'orders', 'workspace_path': str(root)})
            names = {symbol['name'] for file in catalog['files'] for symbol in file['symbols']}
            if set(expected) <= names:
                return
            assert time.monotonic() < deadline, (expected, names)
            time.sleep(.075)

    try:
        request('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                              'clientInfo': {'name': 'septum-regressions', 'version': '1'}})
        server.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
        server.stdin.flush()
        invalid_boundary_inputs = [
            {'scope': scope, 'file_path': 'src/orders/Order.ts',
             **({'domain': 'orders'} if scope == 'domain' else {})}
            for scope in ['staged', 'all', 'domain']
        ] + [
            {'scope': scope, 'file_paths': ['src/orders/Order.ts'],
             **({'domain': 'orders'} if scope == 'domain' else {})}
            for scope in ['staged', 'all', 'domain']
        ] + [
            {'scope': 'file'}, {'scope': 'file', 'file_paths': []},
            {'scope': 'file', 'domain': 'orders'}, {'scope': 'domain'},
            {'scope': 'domain', 'domain': 'missing'},
            {'scope': 'staged', 'domain': 'missing'},
            {'staged': True, 'file_path': 'src/orders/Order.ts'},
            {'scope': 'all', 'staged': True},
            {'scope': 'all', 'domain': 'orders'},
            {'scope': 'staged', 'proposed_imports': ['../billing/Invoice']},
        ]
        for invalid_args in invalid_boundary_inputs:
            result = request('tools/call', {'name': 'septum_boundary',
                             'arguments': {**invalid_args, 'workspace_path': str(a)}})
            assert result.get('isError') is True, (invalid_args, result)
        args = {'file_path': 'src/orders/Order.ts', 'proposed_imports': ['../billing/Invoice'], 'workspace_path': str(a)}
        assert tool('septum_boundary', args)['status'] == 'approved'
        bun_eval('''import {Database} from 'bun:sqlite'; const db=new Database('.septum/septum.db');
          db.query('UPDATE domains SET forbidden_deps_json=? WHERE name=?').run('["billing"]','orders'); db.close();''', a)
        assert tool('septum_boundary', args)['status'] == 'rejected', 'MCP must refresh externally updated rules'
        subprocess.run(['git', 'init', '-q'], cwd=a, check=True)
        (a / 'src/orders/Order.ts').write_text("import {invoice} from '../billing/Invoice';\nexport const order=invoice;\n")
        subprocess.run(['git', 'add', 'src'], cwd=a, check=True)
        (a / 'src/orders/Order.ts').write_text('export function oldOrder() {}\n')
        staged = tool('septum_boundary', {'scope': 'staged', 'workspace_path': str(a)})
        assert staged['status'] == 'rejected', 'MCP staged audit must inspect Git index blobs'
        filtered_staged = tool('septum_boundary', {'scope': 'staged', 'domain': 'orders', 'workspace_path': str(a)})
        assert filtered_staged['scope'] == 'staged' and filtered_staged['status'] == 'rejected', \
            'Domain filter must not turn a staged audit into a working-tree audit'
        tool('septum_domain', {'action': 'catalog', 'domain': 'orders', 'workspace_path': str(b)})
        (b / 'src/orders/Order.ts').write_text('export function newOrder() {}\n')
        time.sleep(.04)
        (b / 'src/orders/Other.ts').write_text('export function newOther() {}\n')
        wait_symbols(b, ['newOrder', 'newOther'])
        (b / 'src/orders/Other.ts').unlink()
        deadline = time.monotonic() + 5
        while True:
            catalog = tool('septum_domain', {'action': 'catalog', 'domain': 'orders', 'workspace_path': str(b)})
            if not any(file['path'].endswith('Other.ts') for file in catalog['files']):
                break
            assert time.monotonic() < deadline, 'Deleted file remained indexed'
            time.sleep(.075)
        unsupported = b / 'src/orders/hello.kt'
        unsupported.write_text('class Hello')
        deadline = time.monotonic() + 5
        while True:
            catalog = tool('septum_domain', {'action': 'catalog', 'domain': 'orders', 'workspace_path': str(b)})
            if 'src/orders/hello.kt' in catalog['index_status']['unsupported_files']:
                break
            assert time.monotonic() < deadline, 'Unsupported source file was not recorded'
            time.sleep(.075)
        result = tool('septum_boundary', {'file_path': 'src/orders/hello.kt', 'workspace_path': str(b)})
        assert result['status'] == 'unknown', 'Unsupported target must not receive approval'
        unsupported.unlink()
        deadline = time.monotonic() + 5
        while True:
            result = tool('septum_boundary', {'scope': 'all', 'workspace_path': str(b)})
            if result['status'] != 'unknown':
                break
            assert time.monotonic() < deadline, 'Deleted unsupported file left stale diagnostics'
            time.sleep(.075)
        (b / 'src/orders').rename(b / 'src/renamed-orders')
        deadline = time.monotonic() + 5
        while True:
            catalog = tool('septum_domain', {'action': 'catalog', 'domain': 'orders', 'workspace_path': str(b)})
            if not catalog['files']:
                break
            assert time.monotonic() < deadline, 'Renamed directory left stale catalog files'
            time.sleep(.075)
        subprocess.run(['git', '-c', 'user.name=Regression', '-c', 'user.email=regression@example.invalid', 'commit', '-qm', 'fixture'], cwd=a, check=True, capture_output=True)
        tool('septum_feature', {'action': 'lock', 'feature_key': 'deletion-test', 'domain': 'orders', 'allowed_touchpoints': ['src/orders/Order.ts'], 'workspace_path': str(a)})
        subprocess.run(['git', 'rm', '-q', 'src/orders/Other.ts'], cwd=a, check=True)
        deletion = tool('septum_boundary', {'scope': 'staged', 'workspace_path': str(a)})
        assert deletion['status'] == 'rejected' and deletion['total_checked'] == 1, deletion
        assert any(v['rule'] == 'touchpoint_violation' for v in deletion['violations']), deletion
        for invalid_session in ['{broken', '{}', '{"feature_key":"f","domain":"orders","touchpoints":[null]}']:
            (a / '.septum/session.json').write_text(invalid_session)
            tool('septum_domain', {'action': 'catalog', 'workspace_path': str(a)})
            rejected = request('tools/call', {'name': 'septum_boundary', 'arguments': {'file_path': 'src/orders/Order.ts', 'workspace_path': str(a)}})
            assert rejected.get('isError'), rejected
            ordinary_release = request('tools/call', {'name': 'septum_feature', 'arguments': {'action': 'release', 'workspace_path': str(a)}})
            assert ordinary_release.get('isError'), ordinary_release
            recovered = request('tools/call', {'name': 'septum_feature', 'arguments': {'action': 'release', 'force': True, 'workspace_path': str(a)}})
            assert not recovered.get('isError'), recovered
            assert not (a / '.septum/session.json').exists()
        print('PASS: boundary scope validation, live rules, staged blobs with domain filters, multi-workspace edits, file/directory reconciliation, unsupported diagnostics, deletion-only touchpoints, corrupt-session recovery')
    finally:
        server.terminate()
        _, stderr = server.communicate(timeout=5)
        selector.close()
        assert server.returncode == 0, stderr
