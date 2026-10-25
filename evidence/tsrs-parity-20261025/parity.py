"""parity.py <repo> <outdir> <tsrs-runs> <tsconfig>...: tsc vs effect-tsrs (TS), effect-tsgo vs effect-tsrs (Effect).

Every command runs alone (sequentially) from the repo root through measure.py, so wall time and peak RSS are its own.
Paths in the summary are repository-relative. Effect sets are (file, line, code, severity); TS sets (file, line, code).
"""
import json, os, re, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
repo, outdir, runs, projects = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4:]
os.makedirs(outdir, exist_ok=True)
tools_bin = os.path.join(repo, 'tools/node_modules/.bin') if os.path.exists(os.path.join(repo, 'tools/node_modules/.bin/effect-tsrs')) else os.path.join(repo, 'node_modules/.bin')
root_bin = os.path.join(repo, 'node_modules/.bin')
TSGO = os.environ.get('EFFECT_TSGO', os.path.join(tools_bin, 'effect-tsgo'))
TSRS = os.environ.get('EFFECT_TSRS', os.path.join(tools_bin, 'effect-tsrs'))
TSC = os.environ.get('TSC', os.path.join(root_bin, 'tsc'))

def rel(p):
    return os.path.relpath(p, repo) if os.path.isabs(p) else os.path.normpath(p)

def measure(tag, cmd):
    out, meta = os.path.join(outdir, tag + '.out'), os.path.join(outdir, tag + '.meta.json')
    subprocess.run([sys.executable, '-I', os.path.join(here, 'measure.py'), out, meta, '--', *cmd], cwd=repo, check=True)
    with open(meta) as f: m = json.load(f)
    with open(out) as f: text = f.read()
    return m, text

TSC_LINE = re.compile(r'^(.+?)\((\d+),(\d+)\): (error|warning) TS(\d+): ')
def tsc_set(text):
    s = set()
    for line in text.splitlines():
        m = TSC_LINE.match(line)
        if m: s.add((rel(m.group(1)), int(m.group(2)), int(m.group(5))))
        elif line.startswith('error TS'): s.add(('<global>', 0, int(line.split('TS')[1].split(':')[0])))
    return s

def effect_set(diags):
    return {(rel(d['file']), d['line'], d['code'], d['severity']) for d in diags}

def gating(s):
    return {x for x in s if x[3] in ('error', 'warning') or x[2] == 377000}

def ts_set_tsrs(diags):
    out = set()
    for d in diags:
        loc = d.get('location')
        out.add((rel(loc['file']), loc['line'], d['code']) if loc else ('<global>', 0, d['code']))
    return out

summary = []
for project in projects:
    tag = project.replace('/', '_').replace('.json', '')
    own = set(rel(f) for f in json.loads(subprocess.run([TSC, '-p', project, '--showConfig'], cwd=repo, capture_output=True, text=True, check=True).stdout).get('files', []))
    own = {os.path.normpath(os.path.join(os.path.dirname(project), f)) for f in own}
    tsc_m, tsc_out = measure(tag + '.tsc', [TSC, '-p', project, '--pretty', 'false'])
    tsgo_m, tsgo_out = measure(tag + '.effect-tsgo', [TSGO, 'diagnostics', '--project', os.path.join(repo, project), '--format', 'json'])
    tsgo = json.loads(tsgo_out)
    rs_runs = []
    for i in range(runs):
        m, out = measure(f'{tag}.effect-tsrs.{i}', [TSRS, 'diagnostics', '-p', os.path.join(repo, project), '--format', 'json'])
        rs_runs.append((m, json.loads(out)))
    none_m, _ = measure(tag + '.effect-tsrs-rules-none', [TSRS, 'diagnostics', '-p', os.path.join(repo, project), '--format', 'json', '--rules', 'none'])
    s_go = effect_set(tsgo['diagnostics'])
    sets_rs = [effect_set(r['diagnostics']) for _, r in rs_runs]
    s_rs = sets_rs[0]
    s_rs_own = {x for x in s_rs if x[0] in own}
    ts_tsc = tsc_set(tsc_out)
    ts_rs = [ts_set_tsrs(r['typescriptDiagnostics']) for _, r in rs_runs]
    raw_rs = [json.dumps(sorted(r['diagnostics'], key=lambda d: (d['file'], d['start'], d['code'])), sort_keys=True) + json.dumps(r['typescriptDiagnostics'], sort_keys=True) for _, r in rs_runs]
    row = {
        'project': project,
        'ownFiles': len(own),
        'tsc': {k: tsc_m[k] for k in ('exit', 'wall_s', 'peak_rss_mb')} | {'errors': len(ts_tsc)},
        'effectTsgo': {k: tsgo_m[k] for k in ('exit', 'wall_s', 'peak_rss_mb')} | {'diagnostics': len(s_go), 'gating': len(gating(s_go)), 'filesChecked': tsgo['summary'].get('filesChecked'), 'filesWithoutPlugin': tsgo['summary'].get('filesWithoutPlugin')},
        'effectTsrs': [{k: m[k] for k in ('exit', 'wall_s', 'peak_rss_mb')} for m, _ in rs_runs],
        'effectTsrsRulesNone': {k: none_m[k] for k in ('exit', 'wall_s', 'peak_rss_mb')},
        'effectTsrsDiagnostics': len(s_rs), 'effectTsrsOwnFileDiagnostics': len(s_rs_own), 'effectTsrsGatingOwn': len(gating(s_rs_own)), 'effectTsrsGatingAll': len(gating(s_rs)),
        'effectTsrsFilesChecked': rs_runs[0][1]['summary']['filesChecked'],
        'effectOwnEqual': s_go == s_rs_own,
        'effectGatingOwnEqual': gating(s_go) == gating(s_rs_own),
        'onlyTsgo': sorted(s_go - s_rs_own)[:20], 'onlyTsrsOwn': sorted(s_rs_own - s_go)[:20],
        'gatingOutsideOwn': sorted(gating(s_rs) - gating(s_rs_own))[:20],
        'tsEqual': ts_tsc == ts_rs[0], 'onlyTsc': sorted(ts_tsc - ts_rs[0])[:20], 'onlyTsrs': sorted(ts_rs[0] - ts_tsc)[:20],
        'deterministic': len(set(raw_rs)) == 1,
    }
    summary.append(row)
    print(json.dumps({k: row[k] for k in ('project', 'effectOwnEqual', 'effectGatingOwnEqual', 'tsEqual', 'deterministic')}), flush=True)
with open(os.path.join(outdir, 'summary.json'), 'w') as f: json.dump(summary, f, indent=1)
