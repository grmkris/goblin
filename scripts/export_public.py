"""Build a separate, sanitized history. Never mirror private Git objects or refs."""
from __future__ import annotations
import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import tempfile
import datetime

ROOT = Path(__file__).resolve().parent.parent
POLICY = ROOT / 'scripts/publication'
EXCLUDED = (
    '.agents/**', '.claude/**', '.codex/**', '.cursor/**', '.grok/**', '.mcp.json',
    '.local/**', '.alchemy/**', '.aws/**', '.github/**', 'evidence/**',
    'AGENTS.md', 'CLAUDE.md', '*/AGENTS.md', '*/CLAUDE.md', 'docs/agents/**',
    'docs/goblin-cutover-handoff.md', 'docs/implementation.md', 'docs/evidence/**',
    'scripts/release*.py', 'scripts/promote*.py', 'scripts/publish*.py',
    'scripts/export_public*.py', 'scripts/publication_audit*.py', 'scripts/ci_credentials.py', 'scripts/publication/**',
    'scripts/wallet_release*.py', 'scripts/ci_credentials_test.py',
    'scripts/publication-*.json', 'scripts/github-known-hosts',
)
PRIVATE_PATTERNS = (
    (r'file:///[^\s<>)]*', 'https://example.invalid/private-reference'),
    (r'https?://[^\s<>)]*(?:/ws_[A-Za-z0-9]+|myplan[^\s<>)]*/(?:w|workspaces|documents)/)[^\s<>)]*', 'https://example.invalid/private-reference'),
    (r'\bws_[A-Za-z0-9]{12,}\b', 'private-workspace'),
    (r'/home/(?:kristjan|ubuntu|claude)(?:/[^\s`"\'<>)]*)?', '/path/to/project'),
    (r'~/(?:\.claude/(?:plans|projects)|\.codex/(?:sessions|memories))[^\s`<>)]*', 'private-planning-record'),
    (r'\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b', '127.0.0.1'),
    (r'https?://(?:goblin|purrable)-[^\s/<>)]*\.grmkris\.workers\.dev', 'https://your-worker.workers.dev'),
)


def git(repo, *args, data=None, env=None):
    result = subprocess.run(['git', '-c', 'safe.directory=' + str(repo), *args], cwd=repo,
                            input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if result.returncode:
        # Do not expose command arguments or subprocess output: either may contain credentials/content.
        raise RuntimeError('git_operation_failed: ' + args[0])
    return result.stdout


def head(repo):
    result = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=repo, capture_output=True)
    return result.stdout.decode().strip() if result.returncode == 0 else None


def excluded(path):
    return any(fnmatch.fnmatch(path, pattern) for pattern in EXCLUDED)


def sanitize(text):
    for pattern, replacement in PRIVATE_PATTERNS:
        text = re.sub(pattern, replacement, text)
    return text


def sanitize_message(text):
    text = sanitize(text)
    text = re.sub(r'\b(?:fuck(?:ing|ed)?|retarded|shit)\b', '[edited]', text, flags=re.I)
    return text.strip() or 'Update project'


def portable_manifest(data):
    manifest = json.loads(data)
    scripts = manifest.get('scripts', {})
    for name in ['release', 'promote', 'publish', 'test:release']:
        scripts.pop(name, None)
    # Agent configuration is private. Product gates and the test/tooling workspaces remain intact.
    scripts['agents:check'] = 'bun tools/docs-public.ts'
    for name in ['check', 'check:fast']:
        if name in scripts:
            scripts[name] = scripts[name].replace('bun run test:release && ', '').replace('python3 -B scripts/release_test.py && ', '')
    if 'check' in scripts:
        scripts['check:public'] = scripts['check']
    manifest['license'] = 'PolyForm-Noncommercial-1.0.0'
    return (json.dumps(manifest, indent=2) + '\n').encode()


def transform(path, data):
    if path == 'package.json':
        return portable_manifest(data)
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return data
    text = sanitize(text)
    if path.endswith('.md'):
        # Remove links to private coordination/configuration while retaining the technical prose.
        def link(match):
            target = match[2].split('#', 1)[0]
            absolute = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
            return match[1] if excluded(absolute) else match[0]
        text = re.sub(r'\[([^\]]+)\]\(([^\s)]+)\)', link, text)
        text = re.sub(r'^.*(?:Claude session|tmux pane|private-planning-record).*(?:\n|$)', '', text, flags=re.M)
    if path == 'scripts/stage.ts' or path == 'scripts/wallet-stage.ts':
        text = text.replace("import { homedir } from 'node:os'\n", '')
        text = text.replace("resolve(homedir(), '.config/myapps/dev.env')", "resolve(root, '.local/cloud.env')")
    return text.encode()


def overlays():
    return {path.relative_to(POLICY).as_posix().removesuffix('.public'): path.read_bytes()
            for path in POLICY.rglob('*') if path.is_file()}


def write_tree(source, target, sha, raw_cache, hash_cache, extra, index):
    entries = {}
    for row in git(source, 'ls-tree', '-r', '-z', sha).split(b'\0'):
        if not row:
            continue
        metadata, raw_path = row.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split()
        path = raw_path.decode('utf-8')
        if excluded(path):
            continue
        if kind != 'blob':
            raise RuntimeError('unsupported_public_submodule')
        key = (path, oid)
        if oid not in raw_cache:
            raw_cache[oid] = git(source, 'cat-file', 'blob', oid)
        if key not in hash_cache:
            data = transform(path, raw_cache[oid])
            if mode == '120000':
                link = data.decode()
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), link))
                if link.startswith('/') or resolved.startswith('../') or excluded(resolved):
                    raise RuntimeError('unsafe_public_symlink')
            hash_cache[key] = git(target, 'hash-object', '-w', '--stdin', data=data).decode().strip()
        entries[path] = (mode, hash_cache[key])
    for path, data in extra.items():
        entries[path] = ('100644', git(target, 'hash-object', '-w', '--stdin', data=data).decode().strip())
    env = dict(os.environ, GIT_INDEX_FILE=str(index))
    git(target, 'read-tree', '--empty', env=env)
    rows = b''.join(f'{mode} {oid}\t{path}\0'.encode() for path, (mode, oid) in sorted(entries.items()))
    git(target, 'update-index', '-z', '--index-info', data=rows, env=env)
    return git(target, 'write-tree', env=env).decode().strip()


def export(source, destination, sha, map_path):
    source, destination, map_path = Path(source).resolve(), Path(destination).resolve(), Path(map_path).resolve()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise RuntimeError('full_commit_sha_required')
    if not (destination / '.git').exists():
        destination.mkdir(parents=True, exist_ok=True)
        if list(destination.iterdir()):
            raise RuntimeError('public_destination_must_be_empty')
        git(destination, 'init', '-b', 'main')
    state = json.loads(map_path.read_text()) if map_path.exists() else {'commits': {}, 'public': None, 'source': None}
    if head(destination) != state['public']:
        raise RuntimeError('public_destination_diverged')
    if state['source']:
        git(source, 'merge-base', '--is-ancestor', state['source'], sha)
    extra = overlays()
    digest = hashlib.sha256(Path(__file__).read_bytes() + b''.join(p.encode() + b'\0' + d for p, d in sorted(extra.items()))).hexdigest()
    if sha == state['source'] and digest == state.get('policy'):
        return state | {'exported': 0}
    mapping = state['commits']
    previous = state['public']
    raw_cache, hash_cache = {}, {}
    exported = 0
    with tempfile.TemporaryDirectory(prefix='goblin-public-index-') as directory:
        index = Path(directory) / 'index'
        for commit in git(source, 'rev-list', '--reverse', '--topo-order', sha).decode().splitlines():
            if commit in mapping:
                continue
            parents = git(source, 'show', '-s', '--format=%P', commit).decode().split()
            projected_parents = list(dict.fromkeys(mapping[parent] for parent in parents if mapping.get(parent)))
            tree = write_tree(source, destination, commit, raw_cache, hash_cache, extra, index)
            if projected_parents and git(destination, 'rev-parse', projected_parents[0] + '^{tree}').decode().strip() == tree:
                mapping[commit] = projected_parents[0]
                continue
            fields = git(source, 'show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', commit).decode().rstrip('\n').split('\0')
            env = dict(os.environ, **dict(zip(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
                                               'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE'], fields)))
            message = sanitize_message(git(source, 'show', '-s', '--format=%B', commit).decode('utf-8', 'replace')) + '\n'
            args = ['commit-tree', tree]
            for parent in projected_parents:
                args += ['-p', parent]
            mapping[commit] = git(destination, *args, data=message.encode(), env=env).decode().strip()
            exported += 1
        public = mapping[sha]
        final_tree = write_tree(source, destination, sha, raw_cache, hash_cache, extra, index)
        if git(destination, 'rev-parse', public + '^{tree}').decode().strip() != final_tree:
            env = dict(os.environ, GIT_AUTHOR_NAME='Goblin publication', GIT_AUTHOR_EMAIL='source@goblin.surf',
                       GIT_COMMITTER_NAME='Goblin publication', GIT_COMMITTER_EMAIL='source@goblin.surf',
                       GIT_AUTHOR_DATE=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       GIT_COMMITTER_DATE=datetime.datetime.now(datetime.timezone.utc).isoformat())
            public = git(destination, 'commit-tree', final_tree, '-p', public,
                         data=b'Update public distribution metadata\n', env=env).decode().strip()
            mapping[sha] = public
    if previous:
        git(destination, 'merge-base', '--is-ancestor', previous, public)
    git(destination, 'update-ref', 'refs/heads/main', public, previous or '0' * 40)
    git(destination, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    # This is an exporter-owned checkout, with no user edits or private ignored files.
    git(destination, 'read-tree', '--reset', '-u', public)
    state = {'commits': mapping, 'source': sha, 'public': public, 'policy': digest, 'published': state.get('published')}
    map_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = map_path.with_suffix('.pending')
    temporary.write_text(json.dumps(state, indent=2) + '\n')
    temporary.replace(map_path)
    return state | {'exported': exported}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('sha')
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--map', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=ROOT)
    args = parser.parse_args()
    result = export(args.source, args.destination, args.sha, args.map)
    print(json.dumps({key: result[key] for key in ['source', 'public', 'exported']}))
