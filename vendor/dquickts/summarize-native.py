"""Summarize local WASM/native receipts; no billing or Worker-CPU inference."""
import hashlib
import json
from pathlib import Path
from statistics import median

root = Path(__file__).resolve().parents[2]
receipts = root / '.local'
data = {name: json.loads((receipts / 'native' / f'{name}.json').read_text())
        for name in ('cpu', 'isolation', 'latency', 'blocked')}
for engine in ('wasm', 'native'):
    for name in ('after', 'replay', 'recovery'):
        value = json.loads((receipts / 'durable-code' / f'{engine}-{name}.json').read_text())
        value.pop('instance', None)
        data[f'{engine}-{name}'] = value
data['wasm-snapshot'] = json.loads((receipts / 'durable-code/snapshot.json').read_text())
data['baseline-control'] = json.loads((receipts / 'durable-code/baseline-control.json').read_text())

summary = {}
for engine in ('wasm', 'native'):
    samples = data[f'{engine}-after']['samples']
    replay = data[f'{engine}-replay']['samples']
    blocked = [s for s in data['blocked']['samples'] if s['engine'] == engine]
    summary[engine] = dict(
        slowHostWallMedianMs=median(s['wallMs'] for s in samples),
        slowHostOccupiedMedianMs=median(s['occupiedMs'] for s in samples),
        recoveryMedianMs=median(s['restoreMs'] for s in replay),
        replayMedianMs=median(s['replayMs'] for s in replay),
        evictionResumeMs=data[f'{engine}-recovery']['recoveryMs'],
        heavyElapsedMedianMs=median(s['elapsedMs'] for s in blocked),
        heavyMaxTimerDelayMedianMs=median(s['maxTimerDelayMs'] for s in blocked),
    )
latency = data['latency']['samples']
summary['nativeOperations'] = {name: median(s[name] for s in latency)
                               for name in ('evalHttpMs', 'snapshotHttpMs', 'restoreHttpMs', 'resumeHttpMs')}
summary['nativeOperations'].update(
    evalMs=median(s['evalTiming']['evalMs'] for s in latency),
    snapshotMs=median(s['evalTiming']['snapshotMs'] for s in latency),
    restoreResumeMs=median(s['resumeTiming']['restoreResumeMs'] for s in latency),
    baseBytes=sorted({s['baseBytes'] for s in latency}),
    deltaBytes=sorted({s['deltaBytes'] for s in latency}),
)
summary['wasmOperations'] = {name: median(s[name] for s in data['wasm-snapshot']['samples'])
                             for name in ('evalMs', 'snapshotMs', 'restoreResumeMs')}
summary['cpuAcrossFourSuspensionsMs'] = sum(s['cpuMs'] for s in data['cpu']['samples'])
summary['cpuBudgetMs'] = 100
summary['nativeBinarySha256'] = hashlib.sha256((receipts / 'native/dquickts-native').read_bytes()).hexdigest()
summary['nativeBuild'] = hashlib.sha256((receipts / 'native/dquickts-native').read_bytes()
                                       + (root / 'vendor/dquickts/native-service.py').read_bytes()).hexdigest()
print(json.dumps(dict(summary=summary, raw=data), indent=2))
