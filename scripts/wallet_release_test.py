"""The Wallet release smoke exercises HTTP without a token, signing request or provider call."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from wallet_release import require_release, smoke


class WalletSmokeTest(unittest.TestCase):
    def setUp(self):
        self.responses = {}
        self.requests = []
        responses, requests = self.responses, self.requests

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.respond()

            def do_POST(self):
                self.respond()

            def respond(self):
                requests.append((self.command, self.path, self.headers.get('Authorization')))
                status, body = responses[self.path]
                self.send_response(status)
                self.end_headers()
                self.wfile.write(json.dumps(body).encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.responses.update({
            '/health': (200, {'ok': True, 'live': True}),
            '/.well-known/oauth-authorization-server': (200, {'issuer': self.origin}),
            '/mcp': (401, {'error': 'unauthorized'}),
        })
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_probes_exact_contract_without_credentials(self):
        smoke(self.origin, require_live=True)
        self.assertEqual(self.requests, [
            ('GET', '/health', None),
            ('GET', '/.well-known/oauth-authorization-server', None),
            ('POST', '/mcp', None),
        ])

    def test_testnet_or_unhealthy_wallet_blocks_prod(self):
        self.responses['/health'] = (200, {'ok': True, 'live': False})
        with self.assertRaisesRegex(RuntimeError, 'wallet_live_health_required'):
            smoke(self.origin, require_live=True)
        for body in [{'ok': False, 'live': True}, {'ok': 1, 'live': True}]:
            self.responses['/health'] = (200, body)
            with self.assertRaisesRegex(RuntimeError, 'wallet_health_failed'):
                smoke(self.origin, require_live=True)

    def test_dev_on_testnets_passes_without_live_but_must_be_healthy(self):
        self.responses['/health'] = (200, {'ok': True, 'live': False})
        smoke(self.origin, require_live=False)
        self.assertEqual([path for _, path, _ in self.requests],
                         ['/health', '/.well-known/oauth-authorization-server', '/mcp'])
        self.responses['/health'] = (200, {'ok': False, 'live': False})
        with self.assertRaisesRegex(RuntimeError, 'wallet_health_failed'):
            smoke(self.origin, require_live=False)
        self.responses['/health'] = (503, {'ok': True})
        with self.assertRaisesRegex(RuntimeError, 'wallet_health_failed'):
            smoke(self.origin, require_live=False)

    def test_other_stage_issuer_and_unprotected_mcp_are_refused(self):
        self.responses['/.well-known/oauth-authorization-server'] = (200, {'issuer': 'https://wallet-dev.goblin.surf'})
        with self.assertRaisesRegex(RuntimeError, 'wallet_oauth_issuer_mismatch'):
            smoke(self.origin, require_live=True)
        self.responses['/.well-known/oauth-authorization-server'] = (200, {'issuer': self.origin})
        self.responses['/mcp'] = (200, {'ok': True})
        with self.assertRaisesRegex(RuntimeError, 'wallet_anonymous_mcp_must_be_401'):
            smoke(self.origin, require_live=False)


class WalletReleaseOrderTest(unittest.TestCase):
    def test_wallet_deploys_only_after_goblin_released_the_same_stage_and_sha(self):
        good = {'stage': 'dev', 'sha': 'a' * 40, 'drift': 'verified'}
        require_release(good, 'dev', 'a' * 40)
        for receipt in [{}, good | {'stage': 'prod'}, good | {'sha': 'b' * 40}, good | {'drift': 'failed'}]:
            with self.assertRaisesRegex(RuntimeError, 'wallet_requires_goblin_release_of_same_stage_and_sha'):
                require_release(receipt, 'dev', 'a' * 40)


if __name__ == '__main__':
    unittest.main()
