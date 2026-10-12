"""Deploy Wallet from the accepted source snapshot and verify its public production boundary."""
import datetime
import fcntl
import json
import os
import urllib.error
import urllib.request

from release import STATE, envfile, execute, safe_plan, stage_config, version

ORIGIN = 'https://wallet.goblin.surf'


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


def smoke(origin=ORIGIN):
    status, body = probe(origin + '/health')
    if status != 200:
        raise RuntimeError('wallet_health_failed')
    health = json.loads(body)
    if health.get('ok') is not True or health.get('live') is not True:
        raise RuntimeError('wallet_live_health_required')
    status, body = probe(origin + '/.well-known/oauth-authorization-server')
    if status != 200 or json.loads(body).get('issuer') != origin:
        raise RuntimeError('wallet_oauth_issuer_mismatch')
    status, _ = probe(origin + '/mcp', 'POST')
    if status != 401:
        raise RuntimeError('wallet_anonymous_mcp_must_be_401')


def config():
    directory, shared, _ = stage_config('prod')
    values = envfile(shared) | envfile(directory / 'wallet-prod.env')
    if values.get('WALLET_DOMAIN') != 'wallet.goblin.surf' or values.get('WALLET_LIVE') != '1':
        raise RuntimeError('wallet_live_production_config_required')
    return directory, shared, values


def require_wallet(receipt, sha, current_version):
    if (receipt.get('sha') != sha or receipt.get('worker') != 'goblin-wallet-prod'
            or receipt.get('version') != current_version or receipt.get('acceptance') != 'public'
            or receipt.get('origin') != ORIGIN):
        raise RuntimeError('current_verified_wallet_prod_receipt_required')


def accepted_wallet(sha):
    _, _, values = config()
    receipt = json.loads((STATE / 'receipts/wallet-prod.json').read_text())
    require_wallet(receipt, sha, version(values, 'prod', 'goblin-wallet'))
    return receipt


def deploy_wallet(sha):
    directory, shared, values = config()
    snapshot = STATE / 'checkouts' / sha
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    prefix = STATE / 'logs' / f'{stamp}-wallet-prod-{sha[:12]}'
    env = dict(os.environ, GOBLIN_CONFIRM_PROD='1', GOBLIN_ENV_DIR=str(directory),
               GOBLIN_CLOUD_ENV_FILE=str(shared), GOBLIN_RELEASE_ROOT=str(STATE),
               GOBLIN_STAGE_LOCK_HELD='wallet:' + str(STATE), ALCHEMY_PLAIN='1', CI='true')
    # Hold Wallet's own lock through deployment, smoke and version recording. Never touch funds.
    with (STATE / 'wallet-deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        plan = execute(['bun', 'run', 'plan:wallet-prod'], snapshot, env, prefix.with_suffix('.plan.log'))
        safe_plan(plan)
        execute(['bun', 'run', 'deploy:wallet-prod'], snapshot, env, prefix.with_suffix('.deploy.log'))
        current = version(values, 'prod', 'goblin-wallet')
        smoke()
        if current != version(values, 'prod', 'goblin-wallet'):
            raise RuntimeError('wallet_changed_during_smoke')
        receipt = {'utc': stamp, 'sha': sha, 'worker': 'goblin-wallet-prod', 'origin': ORIGIN,
                   'version': current, 'acceptance': 'public'}
        for path in [STATE / 'receipts/wallet-prod.json', STATE / f'receipts/{stamp}-wallet-prod-{sha[:12]}.json']:
            path.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))
