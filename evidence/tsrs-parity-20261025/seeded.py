"""seeded.py <repo>: copy seed files in, run tsc and effect-tsrs on their projects, compare, remove the seeds."""
import json, os, re, shutil, subprocess, sys
repo = sys.argv[1]
seeds = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'seeds')
TSC = os.path.join(repo, 'node_modules/.bin/tsc')
TSRS = os.path.join(repo, 'tools/node_modules/.bin/effect-tsrs')
projects = ['tools/tsconfig.json', 'apps/runtime/tsconfig.json', 'apps/web/tsconfig.json', 'packages/contracts/tsconfig.json', 'tsconfig.json']
placed = []
LINE = re.compile(r'^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$')
try:
    mapping = {'tools__zz-seed.ts': 'tools/zz-seed.ts', 'apps_runtime_src__zz-seed.ts': 'apps/runtime/src/zz-seed.ts',
               'apps_runtime_src__zz-seed-types.ts': 'apps/runtime/src/zz-seed-types.ts', 'apps_web_src__zz-seed.tsx': 'apps/web/src/zz-seed.tsx',
               'packages_contracts_src__zz-seed.ts': 'packages/contracts/src/zz-seed.ts'}
    for src, dst in mapping.items():
        shutil.copy(os.path.join(seeds, src + '.txt'), os.path.join(repo, dst)); placed.append(os.path.join(repo, dst))
    report = []
    for p in projects:
        tsc = subprocess.run([TSC, '-p', p, '--pretty', 'false'], cwd=repo, capture_output=True, text=True)
        a = []
        for line in tsc.stdout.splitlines():
            m = LINE.match(line)
            if m: a.append((os.path.normpath(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), m.group(5)))
            elif line.strip(): a.append(('<cont>', 0, 0, 0, line.strip()))
        rs = subprocess.run([TSRS, 'diagnostics', '-p', os.path.join(repo, p), '--format', 'json'], cwd=repo, capture_output=True, text=True)
        out = json.loads(rs.stdout)
        b = [(os.path.relpath(d['location']['file'], repo), d['location']['line'], d['location']['column'], d['code'], d['message']) for d in out['typescriptDiagnostics']]
        # tsc puts message chains on following indented lines; effect-tsrs joins them with newlines
        a_heads = [x for x in a if x[0] != '<cont>']
        b_heads = [(f, l, c, code, msg.split('\n')[0]) for f, l, c, code, msg in b]
        a_full = '\n'.join(x[4] if x[0] == '<cont>' else f'{x[0]}({x[1]},{x[2]}): TS{x[3]}: {x[4]}' for x in a)
        b_full = '\n'.join(f'{f}({l},{c}): TS{code}: ' + msg.replace('\n', '\n') for f, l, c, code, msg in b)
        row = {'project': p, 'tscExit': tsc.returncode, 'tsrsExit': rs.returncode, 'tsc': len(a_heads), 'tsrs': len(b), 'positionsAndCodesEqual': sorted(x[:4] for x in a_heads) == sorted(x[:4] for x in b_heads),
               'firstLinesEqual': sorted(a_heads) == sorted(b_heads), 'codes': sorted({x[3] for x in a_heads}),
               'onlyTsc': sorted(set(a_heads) - set(b_heads)), 'onlyTsrs': sorted(set(b_heads) - set(a_heads))}
        report.append(row)
        print(json.dumps({k: row[k] for k in ('project', 'tscExit', 'tsrsExit', 'tsc', 'tsrs', 'positionsAndCodesEqual', 'firstLinesEqual', 'codes')}))
        for k in ('onlyTsc', 'onlyTsrs'):
            for x in row[k]: print('  ', k, x)
    json.dump(report, open(os.path.join(os.environ.get('OUT', os.path.dirname(seeds)), 'seeded.json'), 'w'), indent=1)
finally:
    for f in placed: os.remove(f)
