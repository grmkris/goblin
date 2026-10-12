"""Fail-closed, value-free audit for an exported checkout."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import os
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def private_history_paths(root):
    from export_public import excluded, overlays
    public_overlays = set(overlays())
    paths = subprocess.check_output(['git', 'log', '--format=', '--name-only', 'HEAD'], cwd=root, text=True).splitlines()
    return sorted({path for path in paths if path and excluded(path) and path not in public_overlays})

def leak_findings(root):
    binary = os.environ.get('GOBLIN_GITLEAKS', '/var/lib/goblin-release/tools/gitleaks')
    allowed = {(row['rule'], row['path'], row['sha256']) for row in json.loads((ROOT / 'scripts/publication-fixtures.json').read_text())}
    with tempfile.TemporaryDirectory(prefix='goblin-public-scan-') as directory:
        report = Path(directory) / 'gitleaks.json'
        # Keep detector values private and transient. Output below retains hashes/locations only.
        run = subprocess.run([binary, 'git', '--no-banner', '--report-format', 'json', '--report-path', str(report),
                              '--log-opts=HEAD', str(root)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if run.returncode not in [0, 1] or not report.exists():
            raise RuntimeError('public_history_scanner_failed')
        leaks = json.loads(report.read_text())
        failures = []
        for row in leaks:
            digest = hashlib.sha256(row['Secret'].encode()).hexdigest()
            if (row['RuleID'], row['File'], digest) not in allowed:
                failures.append({'rule': row['RuleID'], 'path': row['File'], 'line': row['StartLine'], 'sha256': digest})
        return failures, len(leaks) - len(failures)


def dependency_findings(root):
    exceptions = json.loads((ROOT / 'scripts/publication-advisories.json').read_text())
    findings, reviewed = [], []
    for directory in [root, root / 'scripts/fixtures/mcp-app', root / 'spikes/coding', root / 'spikes/coding-cf']:
        audit_env = dict(os.environ, BUN_TMPDIR='/tmp/goblin-public-audit')
        Path('/tmp/goblin-public-audit').mkdir(parents=True, exist_ok=True)
        run = subprocess.run(['bun', 'audit', '--json'], cwd=directory, capture_output=True, text=True, env=audit_env)
        if run.returncode not in [0, 1]:
            raise RuntimeError('dependency_audit_failed')
        try:
            report = json.loads(run.stdout)
        except json.JSONDecodeError:
            raise RuntimeError('dependency_audit_result_missing') from None
        for package, advisories in report.items():
            for advisory in advisories:
                if advisory['severity'] not in ['high', 'critical']:
                    continue
                key = advisory['url'].rsplit('/', 1)[-1]
                finding = {'workspace': str(directory.relative_to(root)), 'package': package, 'advisory': key, 'severity': advisory['severity']}
                if key in exceptions and exceptions[key]['package'] == package and finding['workspace'] in exceptions[key]['workspaces']:
                    reviewed.append(finding | {'reason': exceptions[key]['reason']})
                else:
                    findings.append(finding)
    return findings, reviewed


def audit(root: Path, output: Path) -> dict[str, object]:
    private_paths = private_history_paths(root)
    findings, fixtures = leak_findings(root)
    advisories, reviewed = dependency_findings(root)
    result = {'privateHistoryPaths': private_paths, 'historyFindings': findings, 'reviewedFixtureMatches': fixtures,
              'blockingAdvisories': advisories, 'nonApplicableAdvisories': reviewed,
              'status': 'passed' if not private_paths and not findings and not advisories else 'failed'}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + '\n')
    if private_paths or findings or advisories:
        raise RuntimeError('public_history_or_dependency_audit_failed')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(audit(args.root.resolve(), args.output.resolve())))
