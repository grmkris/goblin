"""Materialize bounded Actions secrets without echoing their values."""
import argparse
import os
from pathlib import Path


def paths(stage):
    return [stage + '.env', 'cloud.env', stage + '-session.json', 'smoke-' + stage + '-receipt.json'] + (
        ['wallet-prod.env'] if stage == 'prod' else [])


def credentials(stage, cleanup=False):
    if stage not in ['dev', 'prod']:
        raise RuntimeError('invalid_stage')
    directory = Path('.local')
    if cleanup:
        for name in paths(stage):
            (directory / name).unlink(missing_ok=True)
        return
    os.umask(0o077)
    directory.mkdir(exist_ok=True, mode=0o700)
    entries = [('STAGE_ENV', stage + '.env'), ('CLOUD_ENV', 'cloud.env'), ('OWNER_SESSION', stage + '-session.json')]
    if stage == 'prod':
        entries.append(('WALLET_PROD_ENV', 'wallet-prod.env'))
    for key, _ in entries:
        value = os.environ.get(key)
        if not value and (key != 'OWNER_SESSION' or stage == 'dev'):
            raise RuntimeError('missing_environment_secret: ' + key)
    for key, name in entries:
        value = os.environ.get(key)
        if value:
            (directory / name).write_text(value)
            (directory / name).chmod(0o600)
    with open(os.environ['GITHUB_ENV'], 'a') as handle:
        handle.write('GOBLIN_CLOUD_ENV_FILE=' + str((directory / 'cloud.env').resolve()) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['dev', 'prod'])
    parser.add_argument('--cleanup', action='store_true')
    args = parser.parse_args()
    credentials(args.stage, args.cleanup)
