#!/usr/bin/env python3
"""Sample an already-running native app's process tree; no launch/termination or private command lines."""
import argparse
import json
import platform
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--companion-pid', type=int, required=True)
parser.add_argument('--seconds', type=int, default=20)
parser.add_argument('--label', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
if not 1 <= args.seconds <= 300:
    parser.error('seconds must be between 1 and 300')

def tree_rss(pid, records):
    descendants = {pid}
    while True:
        found = {row[0] for row in records if row[1] in descendants}
        if found <= descendants:
            break
        descendants |= found
    chosen = [row for row in records if row[0] in descendants]
    return {'rss_kib': sum(row[2] for row in chosen), 'process_count': len(chosen)}

samples = []
for _ in range(args.seconds):
    text = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss='], text=True)
    records = [tuple(map(int, line.split())) for line in text.splitlines() if line.strip()]
    app = tree_rss(args.pid, records)
    companion = tree_rss(args.companion_pid, records)
    samples.append({'app': app, 'companion': companion, 'total_rss_kib': app['rss_kib'] + companion['rss_kib']})
    time.sleep(1)
result = {
    'label': args.label, 'platform': platform.system(), 'architecture': platform.machine(),
    'sample_seconds': args.seconds, 'metric': 'sum of resident set size, not proportional/private memory',
    'peak_total_rss_kib': max(row['total_rss_kib'] for row in samples),
    'samples': samples,
    'limitations': ['Shared pages may be counted more than once.', 'Reparented OS WebView helpers may be absent; verify in Activity Monitor.', 'Run one shell at a time when collecting comparable results.', 'This does not measure startup, frame rate or input latency.'],
}
path = Path(args.output)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: result[key] for key in ['label', 'platform', 'peak_total_rss_kib', 'sample_seconds']}))
