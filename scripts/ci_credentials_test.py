"""Transient CI credentials must be required, masked before use, private, and removed even after a failure."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('ci_credentials.py').resolve()
ACCOUNT = 'a' * 32
TOKEN = 'cloudflare-token-fixture'
STORE = {'url': 'https://alchemy-state-store.example.workers.dev', 'authToken': 'store-bearer-fixture',
         'accountId': ACCOUNT}
SESSION = {'origin': 'https://dev.goblin.example', 'cookie': 'session-cookie-fixture\nsecond-line-fixture'}


def secrets(stage):
    values = {
        'GOBLIN_STAGE_ENV': 'GOBLIN_APP_URL=https://dev.goblin.example\nGOBLIN_SIGNUP_MODE=invite\n'
                            'GOBLIN_SMOKE_SESSION_FILE=/home/operator/.local/dev-session.json\n'
                            'GOBLIN_CREDENTIAL_KEY="credential-key-fixture"\n',
        'GOBLIN_CLOUD_ENV': f'CLOUDFLARE_API_TOKEN={TOKEN}\nCLOUDFLARE_ACCOUNT_ID={ACCOUNT}\n',
        'ALCHEMY_STATE_STORE_CREDENTIALS': json.dumps(STORE),
    }
    if stage == 'dev':
        values['GOBLIN_SMOKE_SESSION'] = json.dumps(SESSION)
    return values


class CredentialsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='goblin-ci-credentials-test-')
        self.directory = Path(self.temporary.name)
        self.home = self.directory / 'home'
        self.home.mkdir()
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(('GOBLIN_', 'ALCHEMY_'))}
        self.env.update(HOME=str(self.home), GITHUB_ENV=str(self.directory / 'github-env'))

    def tearDown(self):
        self.temporary.cleanup()

    def run_script(self, *args, **extra):
        return subprocess.run(['python3', '-B', str(SCRIPT), *args], cwd=self.directory, env=self.env | extra,
                              capture_output=True, text=True)

    def local(self, name):
        return self.directory / '.local' / name

    def store(self):
        return self.home / '.alchemy/credentials/default/cloudflare-state-store.json'

    def test_dev_materializes_private_files_and_points_the_smoke_at_its_session(self):
        result = self.run_script('dev', **secrets('dev'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.local('').stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.store().parent.stat().st_mode & 0o777, 0o700)
        for path in [self.local('dev.env'), self.local('cloud.env'),
                     self.local('dev-session.json'), self.store()]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o600, path)
        self.assertEqual(json.loads(self.store().read_text()), STORE)
        stage = self.local('dev.env').read_text().splitlines()
        session = str(self.local('dev-session.json').resolve())
        self.assertEqual([line for line in stage if line.startswith('GOBLIN_SMOKE_SESSION_FILE=')],
                         ['GOBLIN_SMOKE_SESSION_FILE=' + session])
        self.assertIn('GOBLIN_CREDENTIAL_KEY="credential-key-fixture"', stage)
        self.assertEqual((self.directory / 'github-env').read_text(),
                         'GOBLIN_CLOUD_ENV_FILE=' + str(self.local('cloud.env').resolve()) + '\n')

    def test_masks_every_long_value_before_anything_else_and_prints_no_value(self):
        result = self.run_script('dev', **secrets('dev'))
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        masked = {line.removeprefix('::add-mask::') for line in lines if line.startswith('::add-mask::')}
        for value in ['https://dev.goblin.example', 'credential-key-fixture',
                      TOKEN, ACCOUNT, STORE['url'], 'store-bearer-fixture',
                      'session-cookie-fixture', 'second-line-fixture', '/home/operator/.local/dev-session.json']:
            self.assertIn(value, masked)
        self.assertNotIn('invite', masked)
        self.assertNotIn('accountId', masked)
        self.assertEqual(lines[-1], 'dev: materialized GOBLIN_STAGE_ENV, GOBLIN_CLOUD_ENV, '
                                    'ALCHEMY_STATE_STORE_CREDENTIALS, GOBLIN_SMOKE_SESSION')
        self.assertTrue(all(line.startswith('::add-mask::') for line in lines[:-1]))
        self.assertEqual(result.stderr, '')

    def test_cleanup_removes_every_materialized_file(self):
        self.assertEqual(self.run_script('dev', **secrets('dev')).returncode, 0)
        self.local('smoke-dev-receipt.json').write_text('{}')
        cleaned = self.run_script('dev', '--cleanup')
        self.assertEqual(cleaned.returncode, 0, cleaned.stderr)
        self.assertEqual(list(self.local('').iterdir()), [])
        self.assertFalse(self.store().exists())
        self.assertEqual(self.run_script('dev', '--cleanup').returncode, 0)

    def test_a_missing_required_secret_writes_nothing(self):
        for stage, missing in [('dev', 'GOBLIN_SMOKE_SESSION'), ('prod', 'GOBLIN_CLOUD_ENV'),
                               ('prod', 'ALCHEMY_STATE_STORE_CREDENTIALS')]:
            given = secrets(stage)
            del given[missing]
            result = self.run_script(stage, **given)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('missing_environment_secret: ' + missing, result.stderr)
            self.assertFalse((self.directory / '.local').exists())
            self.assertFalse(self.store().exists())
        prod = self.run_script('prod', **secrets('prod'))
        self.assertEqual(prod.returncode, 0, prod.stderr)
        self.assertFalse(self.local('dev-session.json').exists())
        self.assertIn('GOBLIN_SMOKE_SESSION_FILE=/home/operator', self.local('prod.env').read_text())

    def test_refuses_secrets_the_deploy_must_not_hold(self):
        cases = [
            ('GOBLIN_CLOUD_ENV', f'CLOUDFLARE_API_TOKEN={TOKEN}\nCLOUDFLARE_ACCOUNT_ID={ACCOUNT}\nOTHER_KEY=x\n',
             'cloud_env_must_hold_exactly'),
            ('ALCHEMY_STATE_STORE_CREDENTIALS', json.dumps(STORE | {'accountId': 'b' * 32}),
             'state_store_credentials_minted_for_another_account'),
            ('ALCHEMY_STATE_STORE_CREDENTIALS', json.dumps({'url': STORE['url'], 'authToken': 'x' * 10}),
             'state_store_credentials_need_url_authToken_and_accountId'),
        ]
        for key, value, reason in cases:
            given = secrets('dev')
            given[key] = value
            result = self.run_script('dev', **given)
            self.assertNotEqual(result.returncode, 0, key)
            self.assertIn(reason, result.stderr)
            self.assertFalse((self.directory / '.local').exists())


if __name__ == '__main__':
    unittest.main()
