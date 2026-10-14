#!/usr/bin/env python3
"""Run prebuilt desktop artifacts on macOS/Linux, without OS input or screen-capture permissions."""
import argparse
import hashlib
import json
import os
import platform
import plistlib
import queue
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from measure import LIMITATIONS, bounded_integer, collect, descendants, snapshot, summary

ROOT = Path(__file__).resolve().parents[1]
SHELLS = ('gpui', 'tauri', 'electrobun')


class TrialFailure(Exception):
    """Only fixed, content-free codes reach the receipt."""


def launch_path(app):
    app = app.resolve()
    if app.suffix == '.app' and app.is_dir():
        with (app / 'Contents/Info.plist').open('rb') as source:
            name = plistlib.load(source)['CFBundleExecutable']
        if Path(name).name != name:
            raise ValueError('Invalid bundle executable name')
        return app / 'Contents/MacOS' / name, app
    if app.is_dir():
        return app / 'bin/launcher', app
    return app, ROOT


def inventory(path):
    """Inventory shipped files only; never follow symlinks into a build cache or other tree."""
    files = [path] if path.is_file() else path.rglob('*')
    size, allocated, count, links = 0, 0, 0, 0
    for file in files:
        if file.is_symlink():
            links += 1
        elif file.is_file():
            stat = file.stat()
            size += stat.st_size
            allocated += getattr(stat, 'st_blocks', 0) * 512
            count += 1
    return {'name': path.name, 'logical_bytes': size, 'allocated_bytes': allocated, 'files': count, 'symlinks_not_followed': links}


def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            sha.update(chunk)
    return sha.hexdigest()


def parse_ready(line, shell):
    marker = 'DESKTOP_READY '
    if marker not in line:
        return None
    try:
        value = json.loads(line.split(marker, 1)[1])
    except (ValueError, TypeError):
        return None
    if not isinstance(value, dict) or value.get('shell') != shell or value.get('stage') != 'window_created':
        return None
    if value.get('version') != 1 or type(value.get('pid')) is not int or value['pid'] <= 0:
        return None
    # Reconstruct an allowlist; arbitrary host log fields never become report data.
    return {key: value[key] for key in ('version', 'shell', 'stage', 'pid')}


class OwnedProcess:
    def __init__(self, command, cwd, env, shell=None):
        self.messages = queue.Queue(maxsize=1)
        self.started = time.monotonic()
        self.process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
        self.thread = threading.Thread(target=self._read, args=(shell,), daemon=True)
        self.thread.start()

    def _read(self, shell):
        # Discard all unrecognized output, including native errors that might contain URLs.
        for raw in iter(lambda: self.process.stdout.readline(4097), b''):
            if len(raw) > 4096:
                continue
            line = raw.decode('utf-8', errors='replace')
            value = parse_ready(line, shell) if shell else None
            if not shell and line.startswith('COMPANION_READY '):
                value = {'pid': self.process.pid}
            if value:
                try:
                    self.messages.put_nowait((time.monotonic() - self.started, value))
                except queue.Full:
                    pass

    def ready(self, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                elapsed, value = self.messages.get(timeout=.1)
                if self.process.poll() is not None:
                    raise TrialFailure('process_exited_at_readiness')
                if value['pid'] not in descendants([self.process.pid], snapshot()):
                    raise TrialFailure('readiness_pid_not_in_launched_tree')
                return elapsed * 1000, value
            except queue.Empty:
                if self.process.poll() is not None:
                    raise TrialFailure('process_exited_before_readiness')
        raise TrialFailure('readiness_timeout')

    def close(self):
        # Only this run's new process group, never process-name matching or caller-supplied PIDs.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(self.process.pid, sig)
            except ProcessLookupError:
                break
            if sig == signal.SIGTERM:
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        self.process.wait(timeout=5)
        self.thread.join(timeout=2)
        if not self.thread.is_alive():
            self.process.stdout.close()


class Bridge:
    def __init__(self, connection, shell):
        self.origin = connection['origin']
        self.headers = {'authorization': 'Bearer ' + connection['token'], 'x-goblin-shell': shell}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def command(self, value):
        request = urllib.request.Request(self.origin + '/bridge/command', data=json.dumps(value).encode(),
                                         headers={**self.headers, 'content-type': 'application/json'})
        with self.opener.open(request, timeout=5) as response:
            state = json.load(response)
        if state['mode'] != 'fixture':
            raise TrialFailure('unexpected_non_fixture_state')
        return state

    def stream_probe(self):
        request = urllib.request.Request(self.origin + '/bridge/events', headers=self.headers)
        started = time.monotonic()
        with self.opener.open(request, timeout=5) as response:
            deadline = time.monotonic() + 10
            def next_state():
                # Bound the whole probe as well as each socket read, even if comments keep arriving.
                for _ in range(100):
                    if time.monotonic() > deadline:
                        raise TrialFailure('stream_deadline')
                    line = response.readline(1_000_001)
                    if not line or len(line) > 1_000_000:
                        raise TrialFailure('stream_closed_or_oversize')
                    if line.startswith(b'data: '):
                        return json.loads(line[6:])
                raise TrialFailure('stream_snapshot_timeout')
            first = next_state()
            snapshot_ms = (time.monotonic() - started) * 1000
            started = time.monotonic()
            state = self.command({'type': 'send', 'text': 'Fixture benchmark', 'operationId': 'benchmark-stream'})
            accepted_ms = (time.monotonic() - started) * 1000
            seen = 0
            for _ in range(100):
                state = next_state()
                seen += 1
                if state['revision'] > first['revision'] and state['messages'][-1]['text']:
                    break
            else:
                raise TrialFailure('stream_growth_timeout')
            growth_ms = (time.monotonic() - started) * 1000
            stopped_at = time.monotonic()
            stopped = self.command({'type': 'stop'})
            for _ in range(100):
                state = next_state()
                if state['revision'] >= stopped['revision'] and not state['streaming']:
                    break
            else:
                raise TrialFailure('stream_stop_timeout')
            return {
                'scope': 'companion HTTP/SSE only; not renderer receipt or paint',
                'initial_snapshot_ms': snapshot_ms, 'send_http_ms': accepted_ms,
                'send_to_first_nonempty_reply_sse_ms': growth_ms,
                'stop_to_sse_ms': (time.monotonic() - stopped_at) * 1000, 'snapshots_to_growth': seen,
            }


def trial(args, executable, cwd, bun):
    companion = app = None
    receipt = {'status': 'fail'}
    with tempfile.TemporaryDirectory(prefix='goblin-desktop-bench-') as folder:
        connection_file = Path(folder) / 'connection.local.json'
        try:
            companion = OwnedProcess([bun, 'scripts/benchmark-companion.ts', str(connection_file)], ROOT, os.environ.copy())
            companion.ready(args.timeout)
            connection = json.loads(connection_file.read_text())
            env = {**os.environ, 'GOBLIN_DESKTOP_BENCH': '1',
                   'GOBLIN_DESKTOP_CONNECTION': str(connection_file),
                   'GOBLIN_DESKTOP_URL': connection['origin'] + '/?host=' + args.shell + '#token=' + connection['token']}
            app = OwnedProcess([str(executable)], cwd, env, args.shell)
            milliseconds, ready = app.ready(args.timeout)
            receipt.update(spawn_to_window_created_ms=milliseconds, ready=ready)
            bridge = Bridge(connection, args.shell)
            state = bridge.command({'type': 'select', 'id': 'desktop'})
            if args.scenario == 'history':
                state = bridge.command({'type': 'history'})
            expected = 204 if args.scenario == 'history' else 4
            if len(state['messages']) != expected:
                raise TrialFailure('unexpected_fixture_size')
            resources = collect(app.process.pid, companion.process.pid, args.seconds, args.settle)
            receipt.update(message_count_at_sampling=expected, resources=resources)
            if not resources['roots_present_every_sample']:
                raise TrialFailure('resource_root_disappeared')
            stream = bridge.stream_probe()
            receipt['stream'] = stream
            if app.process.poll() is not None:
                raise TrialFailure('app_exited_during_trial')
            receipt['status'] = 'pass'
        except TrialFailure as error:
            receipt['reason'] = str(error)
        except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError):
            receipt['reason'] = 'process_transport_or_sampling_error'
        finally:
            if app:
                app.close()
            if companion:
                companion.close()
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shell', choices=SHELLS, required=True)
    parser.add_argument('--app', type=Path, required=True, help='Prebuilt executable, .app, or Electrobun Linux bundle')
    parser.add_argument('--cwd', type=Path, help='Optional working directory override')
    parser.add_argument('--build-label', required=True, help='For example dev or release; never inferred')
    parser.add_argument('--scenario', choices=['idle', 'history'], default='history')
    parser.add_argument('--trials', type=bounded_integer(1, 50), default=3)
    parser.add_argument('--warmup-runs', type=bounded_integer(0, 5), default=1)
    parser.add_argument('--seconds', type=bounded_integer(1, 60), default=10)
    parser.add_argument('--settle', type=bounded_integer(0, 30), default=3)
    parser.add_argument('--timeout', type=bounded_integer(1, 60), default=30)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if os.name != 'posix':
        parser.error('This runner supports macOS and Linux process groups')
    if args.output.exists():
        parser.error('Use a new output filename to preserve previous trials')
    executable, default_cwd = launch_path(args.app)
    cwd = (args.cwd or default_cwd).resolve()
    bun = shutil.which('bun')
    if not bun or not executable.is_file() or not os.access(executable, os.X_OK) or not cwd.is_dir():
        parser.error('Missing Bun, executable artifact or working directory; build first')
    output = {
        'schema_version': 1, 'shell': args.shell, 'build_label': args.build_label,
        'scenario': args.scenario, 'platform': platform.system(), 'os_release': platform.release(),
        'architecture': platform.machine(), 'logical_cores': os.cpu_count(),
        'bun_cli_version': subprocess.check_output([bun, '--version'], text=True, timeout=5).strip(),
        'python_version': platform.python_version(),
        'startup_metric': 'spawn to host window constructor return; includes stdout/pipe observer delay',
        'cache_state': 'uncontrolled; warmup runs excluded, no cold-start claim',
        'artifact': inventory(args.app.resolve()), 'executable_sha256': digest(executable),
        'lock_sha256': {name: digest(ROOT / name) for name in ['bun.lock', 'Cargo.lock']},
        'shared_web_assets': inventory(ROOT / 'dist'),
        'companion_distribution_size': 'not packaged; shell inventory is not a complete installer',
        'resource_limitations': LIMITATIONS,
        'limitations': ['Native window creation is not first paint, loaded chat, AX or input evidence.',
                        'System WebView helper attribution is incomplete unless separately verified.',
                        'The CLI Bun version may differ from Electrobun bundled Bun.',
                        'Fixture state is service-verified; no renderer acknowledgements are collected.',
                        'SSE timings include the runner observer and never prove rendered latency.'],
        'trials': [],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    interrupted = False
    try:
        for index in range(args.warmup_runs + args.trials):
            try:
                result = trial(args, executable, cwd, bun)
            except TrialFailure as error:
                result = {'status': 'fail', 'reason': str(error)}
            except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                result = {'status': 'fail', 'reason': 'process_transport_or_sampling_error'}
            output['trials'].append({'index': index + 1, 'warmup': index < args.warmup_runs, **result})
            args.output.write_text(json.dumps(output, indent=2) + '\n')
            print(json.dumps({'trial': index + 1, 'status': result['status']}), flush=True)
    except KeyboardInterrupt:
        interrupted = True
    measured = [row for row in output['trials'] if not row['warmup']]
    output['interrupted'] = interrupted
    output['startup_ms'] = summary(row.get('spawn_to_window_created_ms') for row in measured)
    output['measured_passes'] = sum(row['status'] == 'pass' for row in measured)
    output['measured_failures'] = sum(row['status'] == 'fail' for row in measured)
    output['warmup_failures'] = sum(row['status'] == 'fail' for row in output['trials'] if row['warmup'])
    args.output.write_text(json.dumps(output, indent=2) + '\n')
    return 0 if not interrupted and output['measured_passes'] == args.trials and not output['warmup_failures'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
