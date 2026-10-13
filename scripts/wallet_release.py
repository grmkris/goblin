"""Deploy Goblin Wallet on dev or prod from the deploy job's checkout and verify its public boundary.

`python3 -B scripts/wallet_release.py dev|prod <full-sha>` runs in the same CI deploy job right after
`scripts/release.py` passed for that stage and sha, and refuses to run without that job's goblin receipt. The probes
never sign, spend or touch funds.
"""
import argparse
import datetime
import json
import os
import subprocess
import urllib.error
import urllib.request

from release import (LOCAL, SHA, cloud_env, directories, envfile, execute, require_existing, require_release_checkout,
                     safe_plan, version)

ORIGINS = {'dev': 'https://wallet-dev.goblin.surf', 'prod': 'https://wallet.goblin.surf'}
# A Wallet plan that would create the Worker has lost its state.
STATEFUL = ['Wallet']


def probe(url, method='GET'):
    request = urllib.request.Request(url, method=method, headers={'User-Agent': 'goblin-release/1.0'})
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        if response.geturl() != url:
            raise RuntimeError('wallet_smoke_redirected')
        return response.status, response.read(4096)


def smoke(origin, require_live):
    status, body = probe(origin + '/health')
    if status != 200:
        raise RuntimeError('wallet_health_failed')
    health = json.loads(body)
    if health.get('ok') is not True:
        raise RuntimeError('wallet_health_failed')
    # Dev runs on testnets; only prod must report live mainnet rails.
    if require_live and health.get('live') is not True:
        raise RuntimeError('wallet_live_health_required')
    status, body = probe(origin + '/.well-known/oauth-authorization-server')
    if status != 200 or json.loads(body).get('issuer') != origin:
        raise RuntimeError('wallet_oauth_issuer_mismatch')
    status, _ = probe(origin + '/mcp', 'POST')
    if status != 401:
        raise RuntimeError('wallet_anonymous_mcp_must_be_401')


def config(stage):
    values = envfile(cloud_env()) | envfile(LOCAL / f'wallet-{stage}.env')
    if values.get('WALLET_DOMAIN') != ORIGINS[stage].removeprefix('https://'):
        raise RuntimeError('wallet_domain_must_match_stage')
    if stage == 'prod' and values.get('WALLET_LIVE') != '1':
        raise RuntimeError('wallet_live_production_config_required')
    return values


def require_release(receipt, stage, sha):
    """Goblin's own release of this stage and sha passed in this job, with every provenance check it makes."""
    if receipt.get('stage') != stage or receipt.get('sha') != sha or receipt.get('drift') != 'verified':
        raise RuntimeError('wallet_requires_goblin_release_of_same_stage_and_sha')


def deploy_wallet(stage, sha):
    if not SHA.fullmatch(sha):
        raise RuntimeError('full_commit_sha_required')
    if stage == 'prod' and os.environ.get('GOBLIN_CONFIRM_PROD') != '1':
        raise RuntimeError('prod_requires_GOBLIN_CONFIRM_PROD=1')
    values = config(stage)
    receipts, logs = directories(os.environ)
    goblin = receipts / f'{stage}.json'
    require_release(json.loads(goblin.read_text()) if goblin.exists() else {}, stage, sha)
    require_release_checkout(sha)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    prefix = f'{stamp}-wallet-{stage}-{sha[:12]}'
    env = dict(os.environ, GOBLIN_ENV_DIR=str(LOCAL), GOBLIN_CLOUD_ENV_FILE=str(cloud_env()), ALCHEMY_PLAIN='1',
               CI='true')
    plan = execute(['bun', 'run', f'plan:wallet-{stage}'], env, logs / f'{prefix}-plan.log')
    safe_plan(plan)
    require_existing(plan, STATEFUL)
    execute(['bun', 'run', f'deploy:wallet-{stage}'], env, logs / f'{prefix}-deploy.log')
    current = version(values, stage, 'goblin-wallet')
    smoke(ORIGINS[stage], require_live=stage == 'prod')
    if current != version(values, stage, 'goblin-wallet'):
        raise RuntimeError('wallet_changed_during_smoke')
    receipt = {'utc': stamp, 'stage': stage, 'sha': sha, 'worker': f'goblin-wallet-{stage}', 'origin': ORIGINS[stage],
               'version': current, 'acceptance': 'public'}
    (receipts / f'wallet-{stage}.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['dev', 'prod'])
    parser.add_argument('sha')
    args = parser.parse_args()
    try:
        deploy_wallet(args.stage, args.sha)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error))
        raise SystemExit(1) from None
