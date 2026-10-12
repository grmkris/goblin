"""Validate and fast-forward the public repository only after live production acceptance."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from export_public import export, git
from release import ROOT, STATE, accepted_prod, ref
from wallet_release import accepted_wallet

PUBLIC_REPO = 'grmkris/goblin-public'


def remote_head(directory, env):
    rows = git(directory, 'ls-remote', 'ssh://git@github.com/' + PUBLIC_REPO + '.git', 'refs/heads/main', env=env).decode().splitlines()
    return rows[0].split()[0] if rows else None


def public_env(key_file):
    # Public validation runs without the private job's tokens, sessions or deployment credentials.
    return {key: value for key, value in os.environ.items()
            if key in ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'USER', 'LOGNAME']}


def validate(directory, log, env):
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open('w') as output:
        for cwd in [directory, directory / 'scripts/fixtures/mcp-app', directory / 'spikes/coding', directory / 'spikes/coding-cf']:
            if subprocess.run(['bun', 'install', '--frozen-lockfile'], cwd=cwd, env=env,
                              stdout=output, stderr=subprocess.STDOUT).returncode:
                raise RuntimeError('public_frozen_install_failed')
        if subprocess.run(['bun', 'run', 'check:public'], cwd=directory, env=env,
                          stdout=output, stderr=subprocess.STDOUT).returncode:
            raise RuntimeError('public_checkout_checks_failed')
        if git(directory, 'status', '--porcelain').strip():
            raise RuntimeError('public_checks_changed_tracked_source')


def publish(sha):
    if sha != ref('prod'):
        raise RuntimeError('export_must_match_current_prod_branch')
    accepted_prod(sha)  # Verifies stored acceptance against the live Cloudflare version, not just a JSON flag.
    accepted_wallet(sha)
    key = os.environ.get('GOBLIN_PUBLIC_DEPLOY_KEY')
    if not key:
        raise RuntimeError('public_repository_deploy_key_required')
    directory = STATE / 'public/repo'
    map_path = STATE / 'public/map.json'
    result = export(ROOT, directory, sha, map_path)
    with tempfile.TemporaryDirectory(prefix='goblin-public-push-') as temporary:
        key_file = Path(temporary) / 'deploy-key'
        key_file.write_text(key + '\n')
        key_file.chmod(0o600)
        env = public_env(key_file)
        # The host identity is installed separately using GitHub's published keys; never trust a scan alone.
        env['GIT_SSH_COMMAND'] = 'ssh -i ' + str(key_file) + ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=' + str(ROOT / 'scripts/github-known-hosts')
        current = remote_head(directory, env)
        state = json.loads(map_path.read_text())
        published = state.get('published')
        if current not in [published, result['public']]:
            raise RuntimeError('public_remote_diverged')
        validate(directory, STATE / ('logs/public-' + sha[:12] + '.log'), public_env(key_file))
        # Scan every reachable object and lockfile. The checker emits only counts and finding locations.
        from publication_audit import audit
        audit(directory, STATE / 'public/audit.json')
        accepted_prod(sha)  # Recheck after validation; a competing deployment must not publish stale source.
        accepted_wallet(sha)
        if ref('prod') != sha:
            raise RuntimeError('production_changed_during_export')
        git(directory, 'push', 'ssh://git@github.com/' + PUBLIC_REPO + '.git', 'HEAD:refs/heads/main', env=env)
        state['published'] = result['public']
        map_path.write_text(json.dumps(state, indent=2) + '\n')
    print(json.dumps({'source': sha, 'public': result['public'], 'status': 'published'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('sha')
    args = parser.parse_args()
    os.umask(0o007)
    if os.environ.get('GOBLIN_STAGE_LOCK_HELD') != str(STATE):
        os.execvpe('flock', ['flock', '-x', str(STATE / 'deploy.lock'), 'python3', __file__, args.sha],
                  dict(os.environ, GOBLIN_STAGE_LOCK_HELD=str(STATE)))
    try:
        publish(args.sha)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error))
        raise SystemExit(1) from None
