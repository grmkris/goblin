"""Local-only stateless HTTP controller. Authentication material never enters the native child."""
import argparse
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import math
import os
from pathlib import Path
import resource
import select
import signal
import sys
import time

MAX_BYTES = 4 * 1024 * 1024
MEMORY_BYTES = 128 * 1024 * 1024
CPU_TIMER_MARGIN_MS = 10


def child_limits(cpu_ms, wall_ms):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    seconds = max(1, math.ceil(cpu_ms / 1000))
    resource.setrlimit(resource.RLIMIT_CPU, (seconds, seconds))
    signal.signal(signal.SIGPROF, signal.SIG_DFL)
    signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.setitimer(signal.ITIMER_PROF, max(0.001, cpu_ms / 1000))
    signal.setitimer(signal.ITIMER_REAL, wall_ms / 1000)


def execute(binary, payload, cpu_ms, wall_ms):
    """Only signal this freshly forked, unreaped child. wait4 provides user+system CPU."""
    read_in, write_in = os.pipe()
    read_out, write_out = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.dup2(read_in, 0)
            os.dup2(write_out, 1)
            os.closerange(3, 65536)
            child_limits(cpu_ms, wall_ms)
            os.execve(binary, [binary], {})
        except BaseException:
            os._exit(74)
    os.close(read_in)
    os.close(write_out)
    output = bytearray()
    reason = None
    status = usage = None
    try:
        with os.fdopen(write_in, 'wb', buffering=0) as channel:
            try:
                channel.write(payload)
            except BrokenPipeError:
                pass
        deadline = time.monotonic() + wall_ms / 1000 + 0.5
        while True:
            if time.monotonic() >= deadline or len(output) > MAX_BYTES:
                reason = 'native wall or output limit exceeded'
                os.kill(pid, signal.SIGKILL)
                break
            ready, _, _ = select.select([read_out], [], [], 0.05)
            if not ready:
                continue
            block = os.read(read_out, 65536)
            if not block:
                break
            output.extend(block)
    finally:
        os.close(read_out)
        _, status, usage = os.wait4(pid, 0)
    cpu = (usage.ru_utime + usage.ru_stime) * 1000
    death = os.WTERMSIG(status) if os.WIFSIGNALED(status) else None
    if death in (signal.SIGPROF, signal.SIGXCPU) or cpu >= cpu_ms:
        reason = 'native cumulative CPU limit exceeded'
    elif death == signal.SIGALRM:
        reason = 'native wall limit exceeded'
    elif death is not None:
        reason = reason or 'native child terminated by kernel limit'
    elif os.WEXITSTATUS(status) != 0:
        reason = 'native child failed before producing a slice'
    return bytes(output), cpu, death, reason


def unpack(raw):
    header, data = raw.split(b'\n', 1)
    status, fuel, bn, dn, on, ev, sn, rr = map(int, header.split())
    if min(bn, dn, on) < 0 or bn + dn + on != len(data):
        raise ValueError('invalid native frame')
    return dict(status=status, fuel=fuel, output=data[bn + dn:].decode(),
                base=base64.b64encode(data[:bn]).decode(), delta=base64.b64encode(data[bn:bn + dn]).decode(),
                timing=dict(evalMs=ev / 1e6, snapshotMs=sn / 1e6, restoreResumeMs=rr / 1e6))


class Service(HTTPServer):
    request_queue_size = 64
    def __init__(self, binary, port, token, probes):
        # There is deliberately no host override or public bind option.
        super().__init__(('127.0.0.1', port), Handler)
        self.binary = str(Path(binary).resolve())
        self.build = hashlib.sha256(Path(binary).read_bytes() + Path(__file__).read_bytes()).hexdigest()
        self.token = token
        self.key = hmac.digest(token.encode(), b'goblin-native-snapshot-v1', 'sha256')
        self.probes = probes

    def seal(self, snapshot):
        unsigned = {key: value for key, value in snapshot.items() if key != 'mac'}
        return hmac.new(self.key, json.dumps(unsigned, sort_keys=True, separators=(',', ':')).encode(), 'sha256').hexdigest()

    def slice(self, path, request):
        if request.get('build') != self.build:
            raise ValueError('foreign native build')
        run = request['run']
        if not isinstance(run, str) or len(run) > 256:
            raise ValueError('invalid run id')
        used = 0
        budget = int(request.get('cpuBudgetMs', 500))
        if not math.isfinite(budget) or not 1 <= budget <= 1000:
            raise ValueError('invalid CPU budget')
        base = delta = b''
        if path in ('resume', 'restore', 'snapshot'):
            state = request['snapshot']
            if state['build'] != self.build or state['run'] != run:
                raise ValueError('foreign snapshot build or run')
            if not hmac.compare_digest(self.seal(state), state['mac']):
                raise ValueError('snapshot MAC rejected')
            used, budget = state['cpuUsedUs'] / 1000, state['cpuBudgetMs']
            base = base64.b64decode(state['base'], validate=True)
            delta = base64.b64decode(state['delta'], validate=True)
        remaining = min(budget - used, float(request.get('remainingCpuMs', budget)))
        if not math.isfinite(remaining) or remaining <= CPU_TIMER_MARGIN_MS:
            return dict(ok=False, error='native cumulative CPU limit exceeded', cpuMs=0)
        wall = float(request.get('wallMs', 2000))
        if not math.isfinite(wall) or not 1 <= wall <= 5000:
            raise ValueError('invalid wall limit')
        fuel = int(request.get('fuel', 1000))
        if not 1 <= fuel <= 1000000000:
            raise ValueError('invalid fuel')
        op = dict(eval=0, resume=1, snapshot=2, restore=3, network=4, memory=5, wall=6)[path]
        value = request.get('input', '')
        if not isinstance(value, str) or len(value.encode()) > MAX_BYTES:
            raise ValueError('invalid input')
        value = value.encode()
        frame = f'{op} {fuel} {len(base)} {len(delta)} {len(value)}\n'.encode() + base + delta + value
        # Profiling timers have kernel-tick granularity, and wait4 also includes pre-timer startup CPU.
        raw, cpu, death, reason = execute(self.binary, frame, remaining - CPU_TIMER_MARGIN_MS, wall)
        if reason:
            return dict(ok=False, error=reason, cpuMs=cpu, cpuUsedMs=used + cpu, signal=death)
        result = unpack(raw)
        state = None
        if result['status'] == 1:
            state = dict(build=self.build, run=run, base=result.pop('base'), delta=result.pop('delta'),
                         cpuUsedUs=math.ceil((used + cpu) * 1000), cpuBudgetMs=budget)
            state['mac'] = self.seal(state)
        else:
            result.pop('base')
            result.pop('delta')
        return dict(ok=True, build=self.build, **result, snapshot=state, cpuMs=cpu,
                    cpuUsedMs=used + cpu, remainingCpuMs=max(0, budget - used - cpu))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if not hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {self.server.token}'):
            self.reply(401, dict(ok=False, error='native service authentication rejected'))
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= MAX_BYTES:
                raise ValueError('native request size limit')
            path = self.path.removeprefix('/')
            allowed = ('eval', 'resume', 'snapshot', 'restore')
            if self.server.probes:
                allowed += ('network', 'memory', 'wall')
            if path not in allowed:
                raise ValueError('unknown native operation')
            request = json.loads(self.rfile.read(size))
            self.reply(200, self.server.slice(path, request))
        except (ValueError, KeyError, TypeError, OverflowError):
            self.reply(400, dict(ok=False, error='native request or snapshot rejected'))

    def reply(self, status, result):
        data = json.dumps(result, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.wfile.write(data)
        except BrokenPipeError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--test-probes', action='store_true')
    args = parser.parse_args()
    token = sys.stdin.readline(256).strip()
    if len(token) < 32:
        raise ValueError('a local test token is required on stdin')
    server = Service(args.binary, args.port, token, args.test_probes)
    print(json.dumps(dict(port=server.server_port, build=server.build)), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
