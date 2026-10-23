"""Summarize the synthetic receipts after the baseline, runtime unit and integration commands."""
import hashlib
import json
from pathlib import Path
from statistics import median
import sys

root = Path(__file__).resolve().parents[2]
receipts = root / '.local/durable-code'
data = {name: json.loads((receipts / f'{name}.json').read_text())
        for name in ('baseline-control', 'baseline', 'after', 'snapshot', 'replay', 'recovery')}
# The synthetic instance token is irrelevant to timing and is omitted from the public receipt.
data['recovery'].pop('instance', None)
samples = {name: value['samples'] for name, value in data.items() if 'samples' in value}
artifact = (root / 'apps/runtime/src/agent-apps/dquickts/engine.wasm').read_bytes()
summary = {
    'baselineRevision': sys.argv[1],
    'baselineWallMedianMs': median(row['wallMs'] for row in samples['baseline-control']),
    'baselineOccupiedMedianMs': median(row['occupiedMs'] for row in samples['baseline-control']),
    'dquicktsWallMedianMs': median(row['wallMs'] for row in samples['after']),
    'dquicktsOccupiedMedianMs': median(row['occupiedMs'] for row in samples['after']),
    'checkpointRecoveryMedianMs': median(row['restoreMs'] for row in samples['replay']),
    'readOnlyReplayMedianMs': median(row['replayMs'] for row in samples['replay']),
    'baseBytes': sorted({row['baseBytes'] for row in samples['snapshot']}),
    'deltaBytes': sorted({row['deltaBytes'] for row in samples['snapshot']}),
    'restoreResumeMedianMs': median(row['restoreResumeMs'] for row in samples['snapshot']),
    'restoreResumeMinMs': min(row['restoreResumeMs'] for row in samples['snapshot']),
    'restoreResumeMaxMs': max(row['restoreResumeMs'] for row in samples['snapshot']),
    'evictionRecoveryMs': data['recovery']['recoveryMs'],
    'artifactBytes': len(artifact),
    'artifactSha256': hashlib.sha256(artifact).hexdigest(),
}
print(json.dumps({'summary': summary, 'raw': data}, indent=2))
