from mcp_fixture import McpSession
"""F-01/F-02 fresh-process asset, catalog and declaration-selection contract. Optional argument: compiled Septum binary."""
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[2]
COMMAND = [str(Path(sys.argv[1]).resolve())] if len(sys.argv) > 1 else ['bun', 'run', str(PROJECT / 'bin/septum.ts')]
FIXTURES = {
    'sample.ts': 'export function tsOkay() {}',
    'sample.tsx': 'export function tsxOkay() { return <p />; }',
    'sample.js': 'export function jsOkay() {}',
    'sample.php': '<?php function phpOkay() {}',
    'sample.py': 'def pyOkay():\n    pass',
    'sample.go': 'package sample\nfunc GoOkay() {}',
    'sample.rs': 'pub fn rustOkay() {}',
    'Sample.java': 'class JavaOkay {}',
    'Sample.cs': 'class CSharpOkay {}',
    'sample.rb': 'class RubyOkay\nend',
    'sample.kt': 'class KotlinUnsupported',
}

with tempfile.TemporaryDirectory(prefix='septum-capabilities-') as temporary:
    root = Path(temporary)
    (root / 'src').mkdir()
    (root / 'package.json').write_text('{"name":"septum-capability-fixture","private":true}')
    for file, source in FIXTURES.items():
        (root / 'src' / file).write_text(source)
    with McpSession(COMMAND, root) as session:
        request, tool = session.request, session.tool
        listed = request('tools/list', {})['tools']
        assert len(listed) == 5
        assert 'symbol_ref' in next(t for t in listed if t['name'] == 'septum_symbol')['inputSchema']['properties']
        tool('septum_domain', {'action': 'register', 'domain': 'src', 'root': 'src', 'ingest_now': True})
        catalog = tool('septum_domain', {'action': 'catalog', 'domain': 'src', 'detail_level': 'full'})
        assert catalog['index_status']['sync_state'] == 'complete', catalog
        assert 'src/sample.kt' in catalog['index_status']['unsupported_files'], catalog
        indexed = {file['path']: file for file in catalog['files']}
        for file in FIXTURES:
            if file.endswith('.kt'):
                assert 'src/' + file not in indexed
            else:
                assert indexed['src/' + file]['symbols'], (file, catalog)
        languages = {language['id']: language for language in catalog['parser_capabilities']['languages']}
        assert languages['kotlin']['method'] == 'unsupported'
        assert languages['csharp']['method'] == 'tree-sitter'
        assert all(language['coverage'] in ['partial', 'none'] for language in languages.values())
        identity_fixtures = {
            'Overload.java': 'class Overload {\n public int save(int id) { return id; }\n public String save(String id) { return id; }\n}',
            'receiver.go': 'package sample\ntype A struct{}\ntype B struct{}\nfunc (a *A) Save() {}\nfunc (b B) Save() {}',
            'nested.rs': 'mod app { mod billing { pub struct Invoice; impl Invoice { pub fn save(&self) {} pub fn own(&self) {} } } }',
        }
        for file, source in identity_fixtures.items():
            (root / 'src' / file).write_text(source)
        tool('septum_domain', {'action': 'register', 'domain': 'src', 'root': 'src', 'ingest_now': True})
        for action in ['locate', 'inspect']:
            ambiguous = tool('septum_symbol', {'action': action, 'query': 'Overload.save', 'include_source': action == 'inspect'})
            assert ambiguous['status'] == 'ambiguous' and not ambiguous['found'], ambiguous
            assert len(ambiguous['candidates']) == 2
            ref = next(c['symbol_ref'] for c in ambiguous['candidates'] if 'String id' in c['signature'])
            selected = tool('septum_symbol', {'action': 'inspect', 'symbol_ref': ref, 'include_source': True})
            assert selected['symbol_ref'] == ref and 'String save' in selected['source_slice']['text'], selected
        go = tool('septum_symbol', {'action': 'locate', 'query': 'Save'})
        assert go['status'] == 'ambiguous' and len(go['candidates']) == 2, go
        receiver = tool('septum_symbol', {'action': 'inspect', 'query': 'A.Save', 'include_source': True})
        assert receiver['symbol_ref']['receiver'] == '*A' and receiver['source_slice']['text'] == 'func (a *A) Save() {}', receiver
        rust = tool('septum_symbol', {'action': 'locate', 'query': 'app::billing::Invoice::save'})
        assert rust['found'] and rust['container_name'] == 'app::billing::Invoice' and rust['sibling_methods'] == ['own'], rust
        full = tool('septum_domain', {'action': 'catalog', 'domain': 'src', 'detail_level': 'full'})
        refs = [r for f in full['files'] for r in f['declarations'] if r['name'] == 'Overload.save']
        assert len(refs) == 2
        assert tool('septum_symbol', {'action': 'inspect', 'symbol_ref': refs[0]})['symbol_ref'] == refs[0]
        invalid = request('tools/call', {'name': 'septum_symbol', 'arguments': {'action': 'inspect', 'symbol_ref': {**ref, 'end_line': 0}, 'workspace_path': str(root)}})
        assert invalid.get('isError'), invalid
        (root / 'src' / 'Overload.java').write_text(identity_fixtures['Overload.java'] + '\n// new revision')
        tool('septum_domain', {'action': 'register', 'domain': 'src', 'root': 'src', 'ingest_now': True})
        stale = tool('septum_symbol', {'action': 'inspect', 'symbol_ref': ref, 'include_source': True})
        assert stale['status'] == 'stale_reference' and not stale['found'] and 'text' not in stale['source_slice'], stale
        print(json.dumps({'result': 'pass', 'mode': 'binary' if len(COMMAND) == 1 else 'source', 'grammar_fixtures': 10, 'identity_contract': 'overload/receiver/nested-owner/catalog-reference/stale-reference/invalid-selector passed', 'unsupported_fixtures': 1, 'cwd': 'isolated temp directory', 'eof_exit': 0, **({'sha256': hashlib.sha256(Path(COMMAND[0]).read_bytes()).hexdigest()} if len(COMMAND) == 1 else {})}))
