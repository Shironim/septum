"""Read current adapter contracts through disposable fixtures; does not run init.

Usage: python3 scripts/audit-mcp-cli-contracts.py --output /tmp/septum-contract-audit.json
The output records observations, including known inconsistencies; exit 0 means
the probes finished, not that all observed contracts are consistent.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = ['bun', 'run', str(PROJECT / 'bin/septum.ts')]
INSTALLED = shutil.which('septum')
ENV = {k: v for k, v in os.environ.items() if k not in (
    'SEPTUM_WORKSPACE_ROOT', 'WORKSPACE_ROOT', 'SEPTUM_SESSION_ID',
    'SEPTUM_MEMORY_DIAGNOSTICS')}


def cli(command, root, *args):
    result = subprocess.run(command + list(args), cwd=root, env=ENV,
                            capture_output=True, text=True, timeout=20)
    observation = {'args': list(args), 'exit_code': result.returncode,
                   'stdout': result.stdout, 'stderr': result.stderr}
    try:
        observation['json'] = json.loads(result.stdout)
    except ValueError:
        pass
    return observation


def bun_eval(root, body):
    imports = '\n'.join(f'import {{{name}}} from {json.dumps(str(PROJECT / file))};'
                        for name, file in [
                            ('SeptumDatabase', 'src/core/database/client.ts'),
                            ('SeptumRepository', 'src/core/database/repository.ts')])
    subprocess.run(['bun', '-e', imports + '\n' + body], cwd=root, env=ENV,
                   check=True, capture_output=True, text=True, timeout=20)


def setup(base, name):
    root = base / name
    (root / 'src/orders').mkdir(parents=True)
    (root / 'src/billing').mkdir(parents=True)
    (root / 'package.json').write_text('{}\n')
    (root / 'src/billing/Invoice.ts').write_text('export function invoice() { return 1; }\n')
    (root / 'src/orders/Order.ts').write_text(
        "import {invoice} from '../billing/Invoice';\n"
        'export function calculateTotal() { return invoice(); }\n')
    # Twelve qualifying hotspots make the advertised 30 versus actual 10 visible.
    (root / 'src/orders/Hotspots.ts').write_text('\n'.join(
        f'export function hotspot{i}(value: number) {{\n  if (value > 0) {{\n' +
        '\n'.join('    value += 1;' for _ in range(32)) +
        '\n  }\n  return value;\n}' for i in range(12)))
    bun_eval(root, """const db=new SeptumDatabase(); const repo=new SeptumRepository(db.raw);
      repo.upsertDomain('orders',{root:'src/orders',forbidden_dependencies:['billing']});
      repo.upsertDomain('billing',{root:'src/billing'}); db.close();""")
    ingest = cli(SOURCE, root, 'sync')
    assert ingest['exit_code'] == 0, ingest
    # Seed a known execution slice to test adapter output, not route extraction.
    bun_eval(root, """const db=new SeptumDatabase(); const repo=new SeptumRepository(db.raw);
      const domain=repo.getAllDomains().find(d=>d.name==='orders');
      repo.upsertVerticalSlice({domain_id:domain.id,feature_key:'orders.total',
        http_method:'GET',route_uri:'/orders/total',route_name:'orders.total',
        controller_class:'OrderController',action_name:'calculateTotal',
        controller_file:'src/orders/Order.ts',controller_line:2,
        architecture_style:'mvc',entry_kind:'http_route',
        execution_chain_json:JSON.stringify([
          {stage:'ingress',symbol:'GET /orders/total',file:'src/orders/Order.ts'},
          {stage:'controller',symbol:'calculateTotal',file:'src/orders/Order.ts',line:2}])});
      db.close();""")
    subprocess.run(['git', 'init', '-q'], cwd=root, check=True, capture_output=True)
    subprocess.run(['git', 'add', 'src'], cwd=root, check=True, capture_output=True)
    return root


class MCP:
    def __init__(self, command, root):
        self.stderr = tempfile.TemporaryFile()
        self.process = subprocess.Popen(command + ['serve'], cwd=root, env=ENV,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr)
        self.serial = 0
        self.buffer = b''
        try:
            self.identity = self.request('initialize', {
                'protocolVersion': '2024-11-05', 'capabilities': {},
                'clientInfo': {'name': 'contract-audit', 'version': '1'}})
            self.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        except BaseException:
            self.close()
            raise

    def send(self, message):
        self.process.stdin.write(json.dumps(message).encode() + b'\n')
        self.process.stdin.flush()

    def request(self, method, params):
        self.serial += 1
        self.send({'jsonrpc': '2.0', 'id': self.serial, 'method': method, 'params': params})
        deadline = time.monotonic() + 20
        while True:
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                message = json.loads(line)
                if message.get('id') == self.serial:
                    if 'error' in message:
                        return {'rpc_error': message['error']}
                    return message['result']
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                raise TimeoutError(method)
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError(f'Server closed stdout during {method}')
            self.buffer += chunk

    def tool(self, name, args):
        result = self.request('tools/call', {'name': name, 'arguments': args})
        text = result.get('content', [{}])[0].get('text', '')
        observation = {'name': name, 'args': args, 'isError': bool(result.get('isError')),
                       'text': text}
        if 'rpc_error' in result:
            observation['rpc_error'] = result['rpc_error']
        try:
            observation['json'] = json.loads(text)
        except ValueError:
            pass
        return observation

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.communicate()
        self.stderr.close()
        return self.process.returncode


def audit(command, root):
    result = {'command': command, 'cwd': str(root), 'cli': {}, 'mcp': {}}
    for key, args in {
        'version': ['--version'], 'help': ['--help'],
        'query_macro': ['query', '--json'],
        'query_domain': ['query', 'orders', '--json'],
        'query_full': ['query', 'orders', '--full', '--file', 'Order.ts', '--json'],
        'query_missing': ['query', 'missing', '--json'],
        'locate': ['locate', 'calculateTotal', '--domain', 'orders', '--json'],
        'locate_missing': ['locate', 'nonexistentXYZ', '--json'],
        'locate_empty': ['locate'],
        'slice_found': ['slice', 'GET /orders/total', '--max-depth', '5', '--json'],
        'slice_missing': ['slice', 'GET /absent', '--max-depth', '99', '--json'],
        'slice_invalid_depth': ['slice', 'GET /absent', '--max-depth', 'oops', '--json'],
        'check_warn': ['check'], 'check_strict': ['check', '--strict'],
        'check_staged': ['check', '--staged', '--strict'],
        'check_typo': ['check', '--strcit'],
        'check_domain_flag': ['check', '--domain', 'missing', '--strict'],
        'feature_status_json': ['feature', 'status', '--json'],
        'feature_invalid': ['feature', 'lock'],
        'unknown_command': ['inspect', 'calculateTotal'],
        'topology_json': ['topology', '--json'],
        'topology_missing_resolve': ['topology', 'resolve'],
        'topology_invalid_action': ['topology', 'wrong-action'],
    }.items():
        result['cli'][key] = cli(command, root, *args)
        if key == 'query_full':
            result['cli'][key]['catalog_access_exists_after'] = (root / '.septum/catalog_access.json').exists()
    server = MCP(command, root)
    try:
        result['identity'] = server.identity
        result['tools_list'] = server.request('tools/list', {})
        cases = {
            'domain_default': ('septum_domain', {}),
            'domain_catalog': ('septum_domain', {'domain': 'orders'}),
            'domain_full': ('septum_domain', {'domain': 'orders', 'detail_level': 'full', 'file_filter': 'Order.ts'}),
            'domain_missing': ('septum_domain', {'domain': 'missing'}),
            'domain_invalid_action': ('septum_domain', {'action': 'wrong-action'}),
            'domain_register_missing': ('septum_domain', {'action': 'register'}),
            'domain_register_alias': ('septum_domain', {'name': 'extra', 'root': 'src/extra'}),
            'domain_invalid_archetypes': ('septum_domain', {'action': 'register', 'domain': 'bad', 'root': 'src/bad', 'archetypes': {'service': ['**/*.ts']}}),
            'symbol_default': ('septum_symbol', {'query': 'calculateTotal'}),
            'symbol_empty': ('septum_symbol', {}),
            'symbol_missing': ('septum_symbol', {'query': 'nonexistentXYZ'}),
            'symbol_inspect': ('septum_symbol', {'action': 'inspect', 'query': 'calculateTotal'}),
            'symbol_infer_inspect': ('septum_symbol', {'query': 'calculateTotal', 'include_dependencies': False}),
            'symbol_impact': ('septum_symbol', {'action': 'impact', 'query': 'calculateTotal', 'domain': 'missing'}),
            'symbol_impact_no_filter': ('septum_symbol', {'action': 'impact', 'query': 'calculateTotal'}),
            'symbol_hotspots_default': ('septum_symbol', {'action': 'hotspots'}),
            'symbol_hotspots_30': ('septum_symbol', {'action': 'hotspots', 'limit': 30}),
            'symbol_infer_hotspots': ('septum_symbol', {'min_lines': 30}),
            'symbol_bad_limit': ('septum_symbol', {'query': 'calculateTotal', 'limit': 0}),
            'slice_missing': ('septum_slice', {'query': 'GET /absent', 'max_depth': 99}),
            'slice_found': ('septum_slice', {'query': 'GET /orders/total', 'max_depth': 5}),
            'slice_invalid_depth': ('septum_slice', {'query': 'GET /absent', 'max_depth': 'oops'}),
            'slice_empty': ('septum_slice', {}),
            'boundary_default': ('septum_boundary', {}),
            'boundary_staged': ('septum_boundary', {'scope': 'staged'}),
            'boundary_domain': ('septum_boundary', {'scope': 'domain', 'domain': 'missing'}),
            'boundary_file': ('septum_boundary', {'file_path': 'src/orders/Order.ts', 'proposed_imports': ['../billing/Invoice']}),
            'boundary_empty_file_scope': ('septum_boundary', {'scope': 'file'}),
            'boundary_staged_with_file': ('septum_boundary', {'scope': 'staged', 'file_path': 'src/orders/Order.ts'}),
            'boundary_all_with_file': ('septum_boundary', {'scope': 'all', 'file_path': 'src/orders/Order.ts'}),
            'feature_default': ('septum_feature', {}),
            'feature_missing': ('septum_feature', {'feature_key': 'unregistered'}),
            'feature_lock_missing': ('septum_feature', {'action': 'lock'}),
            'feature_lock': ('septum_feature', {'action': 'lock', 'feature_key': 'checkout', 'domain': 'orders', 'allowed_touchpoints': ['src/orders/Order.ts']}),
            'feature_release_owner': ('septum_feature', {'action': 'release'}),
            'feature_get': ('septum_feature', {'action': 'get', 'feature_key': 'checkout'}),
            'topology': ('septum_domain', {'action': 'topology'}),
            'topology_infer': ('septum_domain', {'refresh': True}),
            'topology_bad_resolve': ('septum_domain', {'action': 'topology', 'resolve': {'layer': 'not-a-layer', 'platform': 'demo'}}),
            'topology_resolve': ('septum_domain', {'action': 'topology', 'resolve': {'layer': 'host', 'platform': 'Docker', 'constraints': ['fixture constraint']}}),
            'topology_node': ('septum_domain', {'action': 'topology', 'resolve_node': {'id': 'worker', 'name': 'Worker', 'layer': 'host', 'platform': 'Docker', 'role': 'jobs', 'connected_to': ['database']}}),
            'topology_node_missing_name': ('septum_domain', {'action': 'topology', 'resolve_node': {'id': 'incomplete', 'layer': 'host', 'platform': 'Docker'}}),
            'unknown_tool': ('septum_locate_symbol', {'query': 'calculateTotal'}),
        }
        for key, (name, args) in cases.items():
            result['mcp'][key] = server.tool(name, args)
            if key == 'domain_catalog':
                result['mcp'][key]['catalog_access_exists_after'] = (root / '.septum/catalog_access.json').exists()
            if key in ('feature_release_owner', 'feature_get'):
                result['mcp'][key]['session_exists_after'] = (root / '.septum/session.json').exists()
        result['cli']['feature_status_after_get'] = cli(command, root, 'feature', 'status')
        # Fixture-only recovery test: overwrite owner, then compare MCP and CLI force.
        session_path = root / '.septum/session.json'
        session = json.loads(session_path.read_text())
        session['owner_id'] = 'contract-audit:other-owner'
        session_path.write_text(json.dumps(session))
        result['mcp']['feature_release_force'] = server.tool('septum_feature', {'action': 'release', 'force': True})
        result['mcp']['feature_release_force']['session_exists_after'] = session_path.exists()
        result['cli']['feature_clear_no_force'] = cli(command, root, 'feature', 'clear')
        result['cli']['feature_clear_force'] = cli(command, root, 'feature', 'clear', '--force')
        result['cli']['feature_clear_force']['session_exists_after'] = session_path.exists()
        result['cli']['topology_resolve'] = cli(command, root, 'topology', 'resolve', 'host', 'Docker')
        result['cli']['topology_node'] = cli(command, root, 'topology', 'add-node', 'cli-worker', 'host', 'Docker', '10.0.0.2')
        result['cli']['topology_bad_layer'] = cli(command, root, 'topology', 'resolve', 'not-a-layer', 'demo')
        result['cli']['topology_remove_node'] = cli(command, root, 'topology', 'remove-node', 'cli-worker')
        result['cli']['topology_env_alias'] = cli(command, root, 'env')
        # Explicit path is accepted by the implementation, absent from tools/list.
        result['mcp']['workspace_hint'] = server.tool('septum_domain', {'workspace_path': str(root), 'domain': 'orders'})
    finally:
        result['server_exit_code'] = server.close()
    c, m = result['cli'], result['mcp']
    catalogs_match = lambda a, b: c.get(a, {}).get('json') is not None and c[a]['json'] == {k: v for k, v in m.get(b, {}).get('json', {}).items() if k != 'index_status'}
    result['equivalence_checks'] = {
        'compact_domain_catalog': catalogs_match('query_domain', 'domain_catalog'),
        'full_filtered_domain_catalog': catalogs_match('query_full', 'domain_full'),
        'located_symbol_coordinates': all(c['locate']['json']['exact_symbol'][k] == m['symbol_default']['json']['exact_symbol'][k]
                                          for k in ['name', 'kind', 'signature', 'line_start', 'line_end']),
        'trace_entrypoint_and_chain': all(c['slice_found']['json'][k] == m['slice_found']['json'][k]
                                        for k in ['found', 'entrypoint', 'chain', 'max_depth_applied']),
        'staged_boundary_rejection': c['check_staged']['exit_code'] == 1 and m['boundary_staged']['json']['status'] == 'rejected',
    }
    assert all(result['equivalence_checks'].values()), result['equivalence_checks']
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    files = [PROJECT / 'package.json', PROJECT / 'bin/septum.ts', *sorted((PROJECT / 'src').rglob('*.ts'))]
    evidence = {'project': str(PROJECT), 'generated_at': datetime.now(timezone.utc).isoformat(),
                'source_sha256': {str(p.relative_to(PROJECT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
                'bun_version': cli(['bun'], PROJECT, '--version'), 'runtimes': {}}
    with tempfile.TemporaryDirectory(prefix='septum-contract-audit-') as temporary:
        for name, command in [('source', SOURCE), ('installed', [INSTALLED] if INSTALLED else None)]:
            if command:
                print(f'Probing {name} CLI + MCP', flush=True)
                evidence['runtimes'][name] = audit(command, setup(Path(temporary), name))
        # Run existing handler/schema suites with cwd and session effects isolated.
        unit_root = setup(Path(temporary), 'unit-tests')
        tests = ['bun', 'test', str(PROJECT / 'tests/unit/unified-5-tools.test.ts'),
                 str(PROJECT / 'tests/unit/schema-coercion.test.ts')]
        evidence['unit_tests'] = cli(tests, unit_root)
    if INSTALLED:
        entrypoint = Path(INSTALLED).resolve()
        evidence['installed_entrypoint'] = {'path': str(entrypoint), 'sha256': hashlib.sha256(entrypoint.read_bytes()).hexdigest()}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, indent=2) + '\n')
    print(f'Evidence saved: {args.output}', flush=True)
    assert evidence['unit_tests']['exit_code'] == 0, evidence['unit_tests']['stderr']
    for name, runtime in evidence['runtimes'].items():
        assert runtime['server_exit_code'] == 0, (name, runtime['server_exit_code'])
        assert len(runtime['tools_list']['tools']) == 5, name
    print('PASS: probes completed, five tools per runtime, isolated handler/schema tests passed')


if __name__ == '__main__':
    main()
