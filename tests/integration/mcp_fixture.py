"""Bounded JSON-RPC transport shared by disposable Septum integration fixtures."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time


class McpSession:
    def __init__(self, command, root):
        self.root = Path(root)
        self.stderr = tempfile.TemporaryFile()
        self.server = subprocess.Popen(command + ['serve'], cwd=root,
            env={**os.environ, 'SEPTUM_WORKSPACE_ROOT': str(root)}, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.stderr, bufsize=0)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.server.stdout, selectors.EVENT_READ)
        self.serial, self.buffered, self.output_bytes = 0, b'', 0
        self.latencies_ms = []

    def __enter__(self):
        try:
            self.request('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'foundation-fixture', 'version': '1'}})
            self.server.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
            return self
        except BaseException:
            self.close(False)
            raise

    def request(self, method, params):
        self.serial += 1
        started = time.monotonic()
        self.server.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': self.serial, 'method': method, 'params': params}) + '\n').encode())
        deadline = started + 20
        while time.monotonic() < deadline:
            while b'\n' in self.buffered:
                line, self.buffered = self.buffered.split(b'\n', 1)
                if not line.strip():
                    continue
                response = json.loads(line)
                if response.get('id') == self.serial:
                    assert 'error' not in response, response
                    self.latencies_ms.append((time.monotonic() - started) * 1000)
                    return response['result']
            if self.selector.select(max(0, deadline - time.monotonic())):
                chunk = os.read(self.server.stdout.fileno(), 65536)
                assert chunk, f'Server exited: {self.server.poll()}'
                self.output_bytes += len(chunk)
                self.buffered += chunk
        raise AssertionError(f'RPC timed out: {method}')

    def tool(self, name, args):
        result = self.request('tools/call', {'name': name, 'arguments': {**args, 'workspace_path': str(self.root)}})
        assert not result.get('isError'), result
        return json.loads(result['content'][0]['text'])

    def metrics(self):
        rss = None
        try:
            for line in Path(f'/proc/{self.server.pid}/status').read_text().splitlines():
                if line.startswith('VmHWM:'):
                    rss = int(line.split()[1])
        except OSError:
            pass
        return {'rpc_count': self.serial, 'rpc_latency_sum_ms': round(sum(self.latencies_ms), 3),
                'output_bytes': self.output_bytes, 'observed_process_peak_rss_kib': rss}

    def close(self, require_success=True):
        try:
            if not self.server.stdin.closed:
                self.server.stdin.close()
            try:
                code = self.server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait()
                raise AssertionError('MCP failed to exit after EOF')
            self.stderr.seek(0)
            log = self.stderr.read().decode(errors='replace')
            if require_success:
                assert code == 0, (code, log)
        finally:
            if self.server.poll() is None:
                self.server.kill()
                self.server.wait()
            self.selector.close()
            self.server.stdout.close()
            self.stderr.close()

    def __exit__(self, exc_type, exc, traceback):
        self.close(exc_type is None)
