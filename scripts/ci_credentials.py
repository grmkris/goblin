"""Materialize one stage's GitHub environment secrets as private files, masked in the public log first, and remove them.

`python3 -B scripts/ci_credentials.py dev|prod [--cleanup]`, from the repository root of a deploy job. The secrets
arrive as step environment variables; nothing here prints a value except as an `::add-mask::` command.
"""
import argparse
import json
import os
from pathlib import Path
import sys

LOCAL = Path('.local')
CLOUD_KEYS = {'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'}


def store_credentials():
    # Where Alchemy reads the cached Cloudflare state-store credential: ~/.alchemy/credentials/<profile>/.
    home = Path(os.environ.get('ALCHEMY_HOME') or Path.home() / '.alchemy')
    return home / 'credentials' / (os.environ.get('ALCHEMY_PROFILE') or 'default') / 'cloudflare-state-store.json'


def secrets(stage):
    """(environment variable, destination, kind) for every secret the stage's deploy job materializes."""
    entries = [('GOBLIN_STAGE_ENV', LOCAL / (stage + '.env'), 'env'),
               ('GOBLIN_CLOUD_ENV', LOCAL / 'cloud.env', 'env'),
               ('ALCHEMY_STATE_STORE_CREDENTIALS', store_credentials(), 'json')]
    if stage == 'dev':
        entries.append(('GOBLIN_SMOKE_SESSION', LOCAL / 'dev-session.json', 'json'))
    return entries


def env_values(text):
    values = {}
    for line in text.splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def masks(kind, text):
    """Every value worth masking: env values and JSON strings of 8 or more characters, line by line."""
    values = env_values(text).values() if kind == 'env' else strings(json.loads(text))
    found = set()
    for value in values:
        for line in value.splitlines():
            if len(line.strip()) >= 8:
                found.add(line.strip())
    return sorted(found)


def mask_command(value):
    # The runner unescapes workflow command data, so escape it as @actions/core does.
    return '::add-mask::' + value.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')


def validate(stage, given):
    cloud = env_values(given['GOBLIN_CLOUD_ENV'])
    if set(cloud) != CLOUD_KEYS or not all(cloud.values()):
        raise RuntimeError('cloud_env_must_hold_exactly_CLOUDFLARE_API_TOKEN_and_CLOUDFLARE_ACCOUNT_ID')
    store = json.loads(given['ALCHEMY_STATE_STORE_CREDENTIALS'])
    fields = ['url', 'authToken', 'accountId']
    if not isinstance(store, dict) or not all(isinstance(store.get(key), str) and store[key] for key in fields):
        raise RuntimeError('state_store_credentials_need_url_authToken_and_accountId')
    # Alchemy discards a credential minted for another account and would need a Secrets Store scope to re-derive it.
    if store['accountId'] != cloud['CLOUDFLARE_ACCOUNT_ID']:
        raise RuntimeError('state_store_credentials_minted_for_another_account')
    if stage == 'dev':
        session = json.loads(given['GOBLIN_SMOKE_SESSION'])
        if not isinstance(session, dict) or not session.get('origin') or not session.get('cookie'):
            raise RuntimeError('smoke_session_needs_origin_and_cookie')


def private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    path.write_text(text)
    path.chmod(0o600)


def with_session(text, session):
    # The smoke reads its session from the file the stage env names; point it at the materialized copy.
    lines = [line for line in text.splitlines() if not line.startswith('GOBLIN_SMOKE_SESSION_FILE=')]
    return '\n'.join(lines + ['GOBLIN_SMOKE_SESSION_FILE=' + str(session.resolve())]) + '\n'


def materialize(stage):
    entries = secrets(stage)
    given = {}
    for key, _, kind in entries:
        value = os.environ.get(key, '')
        if not value.strip():
            raise RuntimeError('missing_environment_secret: ' + key)
        if kind == 'json':
            try:
                json.loads(value)
            except ValueError:
                raise RuntimeError('secret_is_not_json: ' + key) from None
        given[key] = value
    # Logs and artifacts are public. Mask first: a later step's output must never show a value in the clear.
    for key, _, kind in entries:
        for value in masks(kind, given[key]):
            print(mask_command(value), flush=True)
    validate(stage, given)
    os.umask(0o077)
    for key, path, _ in entries:
        text = given[key]
        if key == 'GOBLIN_STAGE_ENV' and stage == 'dev':
            text = with_session(text, LOCAL / 'dev-session.json')
        private(path, text)
    with open(os.environ['GITHUB_ENV'], 'a') as handle:
        handle.write('GOBLIN_CLOUD_ENV_FILE=' + str((LOCAL / 'cloud.env').resolve()) + '\n')
    print(stage + ': materialized ' + ', '.join(key for key, _, _ in entries), flush=True)


def cleanup(stage):
    for _, path, _ in secrets(stage):
        path.unlink(missing_ok=True)
    (LOCAL / ('smoke-' + stage + '-receipt.json')).unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['dev', 'prod'])
    parser.add_argument('--cleanup', action='store_true')
    args = parser.parse_args()
    try:
        if args.cleanup:
            cleanup(args.stage)
        else:
            materialize(args.stage)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
