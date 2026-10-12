"""Transient CI credentials must be required, private and removed even after a failure."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('ci_credentials.py').resolve()


class CredentialsTest(unittest.TestCase):
    def test_prod_requires_wallet_secret_then_cleans_all_credentials(self):
        with tempfile.TemporaryDirectory(prefix='goblin-ci-credentials-test-') as temporary:
            directory = Path(temporary)
            env = dict(os.environ, STAGE_ENV='stage-fixture', CLOUD_ENV='cloud-fixture',
                       GITHUB_ENV=str(directory / 'github-env'))
            env.pop('WALLET_PROD_ENV', None)
            missing = subprocess.run(['python3', '-B', str(SCRIPT), 'prod'], cwd=directory, env=env,
                                     capture_output=True, text=True)
            self.assertNotEqual(missing.returncode, 0)
            self.assertIn('missing_environment_secret: WALLET_PROD_ENV', missing.stderr)
            self.assertFalse((directory / '.local/prod.env').exists())
            env['WALLET_PROD_ENV'] = 'wallet-fixture'
            subprocess.run(['python3', '-B', str(SCRIPT), 'prod'], cwd=directory, env=env, check=True)
            for name in ['prod.env', 'cloud.env', 'wallet-prod.env']:
                self.assertEqual((directory / '.local' / name).stat().st_mode & 0o777, 0o600)
            subprocess.run(['python3', '-B', str(SCRIPT), 'prod', '--cleanup'], cwd=directory, env=env, check=True)
            self.assertEqual(list((directory / '.local').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
