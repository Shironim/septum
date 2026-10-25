"""Fixed navigation task protocol. --baseline compares binaries; no percentage language claims."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from mcp_fixture import McpSession

PROJECT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--binary')
parser.add_argument('--baseline')
parser.add_argument('--report', default='/tmp/septum-foundation-navigation.json')
args = parser.parse_args()
corpus_path = PROJECT / 'tests/fixtures/foundation/navigation-corpus.json'
raw_corpus = corpus_path.read_bytes()
corpus = json.loads(raw_corpus)
corpus_hash = hashlib.sha256(raw_corpus).hexdigest()


def run(binary):
    command = [str(Path(binary).resolve())] if binary else ['bun', 'run', str(PROJECT / 'bin/septum.ts')]
    with tempfile.TemporaryDirectory(prefix='septum-navigation-') as temporary:
        root = Path(temporary)
        for file, source in corpus['files'].items():
            target = root / file
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(source)
        with McpSession(command, root) as session:
            tools = session.request('tools/list', {})['tools']
            assert len(tools) == 5
            for name, directory in corpus['domains'].items():
                session.tool('septum_domain', {'action': 'register', 'domain': name, 'root': directory, 'ingest_now': False})
            session.tool('septum_domain', {'action': 'register', 'domain': 'app', 'root': 'app', 'ingest_now': True})
            macro = session.tool('septum_domain', {'action': 'catalog'})
            actual = set()
            relationships = []
            for domain in corpus['domains']:
                catalog = session.tool('septum_domain', {'action': 'catalog', 'domain': domain, 'detail_level': 'full'})
                relationships += catalog.get('relationships', [])
                for edge in catalog.get('relationships', []):
                    if edge['resolution']['status'] == 'resolved':
                        actual.update((edge['source']['file'], file, edge['kind']) for target in edge['resolution']['targets'] for file in target['files'])
            expected = {(e['source'], e['target'], e['kind']) for e in corpus['edges']}
            partition_scores = {}
            for partition in ['development', 'holdout']:
                subset = {(e['source'], e['target'], e['kind']) for e in corpus['edges'] if e['partition'] == partition}
                partition_scores[partition] = {'expected_edges': len(subset), 'matched_edges': len(actual & subset), 'omissions': len(subset - actual)}
            selection = corpus['selection']
            located = session.tool('septum_symbol', {'action': 'locate', 'query': selection['query'], 'file_path': selection['file']})
            checks = {'ambiguity_reported': located.get('status') == 'ambiguous' and len(located.get('candidates', [])) == 2}
            ref = next((c['symbol_ref'] for c in located.get('candidates', []) if c['signature'] == selection['signature']), None)
            checks['selected_current_source'] = False
            checks['stale_source_refused'] = False
            if ref:
                inspected = session.tool('septum_symbol', {'action': 'inspect', 'symbol_ref': ref, 'include_source': True})
                source = inspected.get('source_slice', {})
                checks['selected_current_source'] = source.get('status') == 'current' and source.get('start_line') == selection['start_line'] and source.get('end_line') == selection['end_line'] and source.get('text') == corpus['files'][selection['file']].splitlines()[2]
                (root / selection['file']).write_text(corpus['files'][selection['file']] + '// changed\n')
                stale = session.tool('septum_symbol', {'action': 'inspect', 'symbol_ref': ref, 'include_source': True})
                checks['stale_source_refused'] = stale.get('status') == 'stale_reference' or stale.get('source_slice', {}).get('status') == 'stale'
            decoy = session.tool('septum_symbol', {'action':'inspect','query':'run','file_path':'app/main.ts','include_dependencies':True})
            checks['import_only_is_not_call'] = decoy.get('outbound_calls') == [] and not decoy.get('resolved_outbound_calls') and all(e['kind'] == 'imports' for e in relationships if e['source']['file'] == 'app/main.ts') and any(e['source']['file'] == 'app/main.ts' for e in relationships)
            checks['dynamic_unresolved_reported'] = any(e['source']['file'] == corpus['dynamic_source'] and e['resolution']['reason'] == 'dynamic_target' and e['resolution']['status'] == 'unresolved' for e in relationships)
            route = session.tool('septum_slice', {'query': corpus['route']})
            checks['scoped_ast_route'] = route.get('found') is True and route.get('entrypoint', {}).get('uri') == '/one/items'
            (root / 'app/unknown.kt').write_text('class Unsupported')
            session.tool('septum_domain', {'action': 'register', 'domain': 'app', 'root': 'app', 'ingest_now': True})
            partial = session.tool('septum_boundary', {'scope': 'file', 'file_path': 'app/unknown.kt'})
            checks['partial_index_not_approved'] = partial.get('status') == 'unknown'
            metrics = session.metrics()
            contracts = macro.get('parser_capabilities', {}).get('analysis_contracts')
        return {'mode': 'binary' if binary else 'source', 'binary_sha256': hashlib.sha256(Path(binary).read_bytes()).hexdigest() if binary else None,
                'analysis_contracts': contracts, 'reconnect_required_for_foundation': not contracts or contracts.get('foundation_revision') != '1',
                'tasks': checks, 'task_denominator': len(checks), 'tasks_passed': sum(checks.values()),
                'edge_denominator': len(expected), 'matched_edges': len(actual & expected), 'false_positive_edges': sorted(actual - expected), 'omitted_edges': sorted(expected - actual),
                'partitions': partition_scores, 'metrics': metrics, 'eof_exit': 0,
                'evidence': {'relationships': relationships, 'selected_reference': ref, 'selected_source': inspected.get('source_slice') if ref else None, 'decoy_inspect': decoy}}


report = {'corpus': corpus['id'], 'corpus_sha256': corpus_hash,
          'limits': 'One local run per mode; RPC sum includes ingestion, no warmup or significance claim. RSS is Linux process VmHWM sampled before EOF. No language-accuracy or speedup claim.',
          'baseline': run(args.baseline) if args.baseline else None, 'candidate': run(args.binary)}
assert corpus_path.read_bytes() == raw_corpus, 'Corpus changed during evaluation'
Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'report': args.report, 'corpus_sha256': corpus_hash, 'candidate': {k:v for k,v in report['candidate'].items() if k != 'evidence'}, 'baseline': {k:v for k,v in report['baseline'].items() if k != 'evidence'} if report['baseline'] else None}))
assert report['candidate']['tasks_passed'] == report['candidate']['task_denominator'], report['candidate']['tasks']
# Holdout results are recorded, never used to tune or silently change expected edges.
assert not report['candidate']['false_positive_edges'], report['candidate']['false_positive_edges']
