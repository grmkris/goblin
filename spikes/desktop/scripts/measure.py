#!/usr/bin/env python3
"""Bounded macOS/Linux process sampling. Never reads command lines or changes processes."""
import argparse
import json
import math
import os
import platform
import statistics
import subprocess
import time
from pathlib import Path


def cpu_seconds(value):
    days, clock = value.split('-', 1) if '-' in value else ('0', value)
    parts = clock.split(':')
    if len(parts) not in (2, 3):
        raise ValueError('Unexpected ps CPU time')
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + float(part)
    return int(days) * 86400 + seconds


def parse_ps(text):
    records = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        pid, ppid, rss, cpu, started = line.split(None, 4)
        records[int(pid)] = {
            'pid': int(pid), 'ppid': int(ppid), 'rss_kib': int(rss),
            'cpu_seconds': cpu_seconds(cpu), 'started': started.strip(),
        }
    return records


def snapshot():
    result = subprocess.run(
        ['ps', '-axo', 'pid=,ppid=,rss=,time=,lstart='],
        capture_output=True, text=True, check=True, timeout=5,
        env={**os.environ, 'LC_ALL': 'C'},
    )
    return parse_ps(result.stdout)


def descendants(roots, records):
    chosen = set(roots) & records.keys()
    while True:
        children = {pid for pid, row in records.items() if row['ppid'] in chosen}
        if children <= chosen:
            return chosen
        chosen |= children


def summary(values):
    values = sorted(value for value in values if value is not None)
    if not values:
        return {'count': 0, 'median': None, 'p95': None, 'peak': None, 'min': None}
    return {
        'count': len(values), 'median': statistics.median(values),
        'p95': values[max(0, math.ceil(len(values) * .95) - 1)],
        'peak': values[-1], 'min': values[0],
    }


def sample_row(records, previous, app_pid, companion_pid, helper_pids, identities, elapsed):
    roots = {app_pid, companion_pid, *helper_pids}
    missing = sorted(pid for pid in roots if pid not in records)
    replaced = sorted(pid for pid in roots if pid in records and records[pid]['started'] != identities[pid])
    app = descendants([app_pid, *helper_pids], records)
    companion = descendants([companion_pid], records)
    selected = app | companion
    previous_selected = descendants(roots, previous)
    added = selected - previous_selected
    removed = previous_selected - selected
    changed = {pid for pid in selected & previous_selected if records[pid]['started'] != previous[pid]['started']}
    cpu_valid = not (missing or replaced or added or removed or changed) and elapsed > 0
    delta = sum(records[pid]['cpu_seconds'] - previous[pid]['cpu_seconds'] for pid in selected & previous_selected)
    cpu = 100 * delta / elapsed if cpu_valid and delta >= 0 else None
    observed = sum(records[pid]['rss_kib'] for pid in selected)
    return {
        'app_rss_kib': sum(records[pid]['rss_kib'] for pid in app),
        'companion_rss_kib': sum(records[pid]['rss_kib'] for pid in companion),
        'total_rss_kib': observed if not (missing or replaced) else None,
        'observed_rss_kib': observed, 'process_count': len(selected),
        'cpu_percent_one_core': cpu, 'cpu_interval_seconds': elapsed,
        'missing_root_pids': missing, 'reused_root_pids': replaced,
        'new_pids': sorted(added), 'departed_pids': sorted(removed), 'reused_pids': sorted(changed),
        'overlap_pids_deduplicated': sorted(app & companion),
        'processes': [records[pid] for pid in sorted(selected)],
    }


def collect(app_pid, companion_pid, seconds=20, warmup=2, repeats=1, helper_pids=()):
    baseline = snapshot()
    roots = {app_pid, companion_pid, *helper_pids}
    if not roots <= baseline.keys():
        raise ValueError('A requested PID is not running')
    identities = {pid: baseline[pid]['started'] for pid in roots}
    samples = []
    for repeat in range(repeats):
        time.sleep(warmup)
        previous = snapshot()
        previous_at = time.monotonic()
        deadline = previous_at
        for index in range(seconds):
            deadline += 1
            time.sleep(max(0, deadline - time.monotonic()))
            records = snapshot()
            now = time.monotonic()
            row = sample_row(records, previous, app_pid, companion_pid, helper_pids, identities, now - previous_at)
            samples.append({'repeat': repeat + 1, 'sample': index + 1, **row})
            previous, previous_at = records, now
    return {
        'sample_seconds': seconds, 'warmup_seconds_per_repeat': warmup, 'repeats': repeats,
        'requested_root_pids': sorted(roots),
        'roots_present_every_sample': all(not (row['missing_root_pids'] or row['reused_root_pids']) for row in samples),
        'rss_kib': summary(row['total_rss_kib'] for row in samples),
        'cpu_percent_one_core': summary(row['cpu_percent_one_core'] for row in samples),
        'samples': samples,
    }


LIMITATIONS = [
    'Sum of RSS, not private/proportional memory; shared pages can be counted more than once.',
    'Total deduplicates app/companion/helper PID overlap; separate subtotals can overlap.',
    'Reparented WebView helpers are absent unless explicitly supplied; completeness is not inferred.',
    'CPU is cumulative process CPU-time delta / wall time, 100% = one logical core; ps time has platform-dependent precision.',
    'CPU intervals with process churn are null, not zero; dead/reused roots invalidate total RSS.',
    'Processes born and exited entirely between samples are not observable.',
    'Repeated samples of one process are not independent app launches.',
    'No startup, frame rate, private footprint, input latency, content or command lines are captured.',
]


def bounded_integer(low, high):
    def parse(value):
        number = int(value)
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f'Expected {low}..{high}')
        return number
    return parse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=bounded_integer(1, 2**31 - 1), required=True)
    parser.add_argument('--companion-pid', type=bounded_integer(1, 2**31 - 1), required=True)
    parser.add_argument('--helper-pid', type=bounded_integer(1, 2**31 - 1), action='append', default=[])
    parser.add_argument('--seconds', type=bounded_integer(1, 300), default=20)
    parser.add_argument('--warmup', type=bounded_integer(0, 60), default=2)
    parser.add_argument('--repeats', type=bounded_integer(1, 20), default=1)
    parser.add_argument('--label', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (args.seconds + args.warmup) * args.repeats > 3600:
        parser.error('A sampling run must be at most 3600 seconds')
    try:
        data = collect(args.pid, args.companion_pid, args.seconds, args.warmup, args.repeats, args.helper_pid)
    except (OSError, ValueError, subprocess.SubprocessError):
        parser.exit(1, 'Process sampling failed; check PIDs and local ps support.\n')
    result = {
        'schema_version': 2, 'label': args.label, 'platform': platform.system(),
        'architecture': platform.machine(), 'webview_helper_attribution': 'unverified; supplied PIDs are caller-attributed',
        'metric': 'deduplicated process RSS sum, not private memory', 'limitations': LIMITATIONS, **data,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ['platform', 'rss_kib', 'cpu_percent_one_core', 'roots_present_every_sample']}))
    return 0 if data['roots_present_every_sample'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
