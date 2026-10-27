"""Promotion moves prod only after every check passes, in order, and never rewrites production history."""
import unittest
from promote import promote

A, B = 'a' * 40, 'b' * 40


class FakeGitHub:
    """Records each step; a check fails by raising, as the real ones do."""

    def __init__(self, receipt=None, live='dev-v1', status='ahead', checked=True):
        self.calls = []
        self.receipt = {'sha': A, 'acceptance': 'authenticated', 'version': 'dev-v1'} if receipt is None else receipt
        self.live, self.status, self.checked = live, status, checked

    def source(self, sha):
        self.calls.append(('source', sha))
        if not self.checked:
            raise RuntimeError('successful_dev_check_for_exact_sha_required')

    def acceptance(self, sha):
        self.calls.append(('acceptance', sha))
        return self.receipt

    def dev_version(self):
        self.calls.append(('dev_version',))
        return self.live

    def fast_forward(self, sha):
        self.calls.append(('fast_forward', sha))
        return self.status

    def move_prod(self, sha):
        self.calls.append(('move_prod', sha))


class PromotionTest(unittest.TestCase):
    def test_checks_dev_source_acceptance_and_fast_forward_before_moving_prod(self):
        github = FakeGitHub()
        promote(A, github)
        self.assertEqual(github.calls, [('source', A), ('acceptance', A), ('dev_version',), ('fast_forward', A),
                                        ('move_prod', A)])
        identical = FakeGitHub(status='identical')
        promote(A, identical)
        self.assertEqual(identical.calls[-1], ('move_prod', A))

    def test_any_failed_check_leaves_prod_where_it_is(self):
        receipt = {'sha': A, 'acceptance': 'authenticated', 'version': 'dev-v1'}
        for github in [
            FakeGitHub(checked=False),
            FakeGitHub(receipt=receipt | {'sha': B}),
            FakeGitHub(receipt=receipt | {'acceptance': 'public'}),
            FakeGitHub(receipt=receipt | {'acceptance': 'public',
                                          'signIn': 'skipped: no mailbox access (no OIDC token in this job)'}),
            FakeGitHub(live='dev-v2'),
            FakeGitHub(status='behind'),
            FakeGitHub(status='diverged'),
        ]:
            with self.assertRaises(RuntimeError):
                promote(A, github)
            self.assertNotIn('move_prod', [call[0] for call in github.calls])

    def test_public_dev_acceptance_promotes_only_while_the_smoke_cannot_sign_in(self):
        # ADR 0128: until the checks account's mailbox workload is configured, the dev smoke passes its public checks.
        unset = {'sha': A, 'acceptance': 'public', 'version': 'dev-v1',
                 'signIn': 'skipped: no mailbox access (no workload configured)'}
        github = FakeGitHub(receipt=unset)
        promote(A, github)
        self.assertEqual(github.calls[-1], ('move_prod', A))

    def test_only_a_full_sha_is_promoted(self):
        for sha in [A[:12], 'dev', A.upper(), '']:
            github = FakeGitHub()
            with self.assertRaisesRegex(RuntimeError, 'full_commit_sha_required'):
                promote(sha, github)
            self.assertEqual(github.calls, [])


if __name__ == '__main__':
    unittest.main()
