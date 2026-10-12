"""The promotion smoke exercises HTTP without a token, signing request or provider call."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from wallet_release import smoke


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
        smoke(self.origin)
        self.assertEqual(self.requests, [
            ('GET', '/health', None),
            ('GET', '/.well-known/oauth-authorization-server', None),
            ('POST', '/mcp', None),
        ])

    def test_testnet_or_unhealthy_wallet_blocks_publication(self):
        for body in [{'ok': True, 'live': False}, {'ok': False, 'live': True}, {'ok': 1, 'live': True}]:
            self.responses['/health'] = (200, body)
            with self.assertRaisesRegex(RuntimeError, 'wallet_live_health_required'):
                smoke(self.origin)

    def test_other_stage_issuer_and_unprotected_mcp_are_refused(self):
        self.responses['/.well-known/oauth-authorization-server'] = (200, {'issuer': 'https://wallet-dev.goblin.surf'})
        with self.assertRaisesRegex(RuntimeError, 'wallet_oauth_issuer_mismatch'):
            smoke(self.origin)
        self.responses['/.well-known/oauth-authorization-server'] = (200, {'issuer': self.origin})
        self.responses['/mcp'] = (200, {'ok': True})
        with self.assertRaisesRegex(RuntimeError, 'wallet_anonymous_mcp_must_be_401'):
            smoke(self.origin)


if __name__ == '__main__':
    unittest.main()
