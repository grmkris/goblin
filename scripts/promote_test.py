"""Promotion cannot rewrite production history or bypass stage acceptance."""
import unittest
from promote import require_fast_forward
from wallet_release import require_wallet


class PromotionGuardTest(unittest.TestCase):
    def test_only_fast_forward_or_retry_is_allowed(self):
        for status in ['ahead', 'identical']:
            require_fast_forward(status)
        for status in ['behind', 'diverged', '', None]:
            with self.assertRaises(RuntimeError):
                require_fast_forward(status)

    def test_wallet_receipt_is_bound_to_live_prod_worker_and_origin(self):
        good = {
            'sha': 'a' * 40,
            'worker': 'goblin-wallet-prod',
            'version': 'wallet-v1',
            'acceptance': 'public',
            'origin': 'https://wallet.goblin.surf',
        }
        require_wallet(good, 'a' * 40, 'wallet-v1')
        for change in [
            {'sha': 'b' * 40},
            {'worker': 'goblin-wallet-dev'},
            {'version': 'wallet-v0'},
            {'acceptance': 'authenticated'},
            {'origin': 'https://wallet-dev.goblin.surf'},
        ]:
            with self.assertRaises(RuntimeError):
                require_wallet(good | change, 'a' * 40, 'wallet-v1')


if __name__ == '__main__':
    unittest.main()
