"""Fail-closed checks for promotion, independent of credentials and Cloudflare."""
import unittest
from release import require_check, require_clean_snapshot, require_dev, require_prod, require_ref, resources, safe_plan, stale_checkouts


class PromotionTest(unittest.TestCase):
    def test_only_successful_exact_dev_push_is_accepted(self):
        good = {"head_sha": "a" * 40, "head_branch": "dev", "event": "push", "conclusion": "success"}
        self.assertEqual(require_check([good], "a" * 40, "dev"), good)
        for change in [{"head_sha": "b" * 40}, {"head_branch": "main"}, {"event": "pull_request"}, {"conclusion": "failure"}]:
            with self.assertRaises(RuntimeError):
                require_check([good | change], "a" * 40, "dev")

    def test_branch_targets_reject_stale_dev_and_different_prod(self):
        require_ref("dev", "a" * 40, "a" * 40, None)
        require_ref("prod", "a" * 40, "b" * 40, "a" * 40)
        for stage, dev, prod in [("dev", "b" * 40, None), ("prod", "a" * 40, "b" * 40)]:
            with self.assertRaises(RuntimeError):
                require_ref(stage, "a" * 40, dev, prod)

    def test_export_requires_current_accepted_production(self):
        good = {"stage": "prod", "sha": "a" * 40, "acceptance": "public", "version": "v1", "drift": "verified"}
        require_prod(good, "a" * 40, "v1")
        for change in [{"stage": "dev"}, {"sha": "b" * 40}, {"acceptance": "failed"}, {"drift": "failed"}, {"version": "v0"}]:
            with self.assertRaises(RuntimeError):
                require_prod(good | change, "a" * 40, "v1")

    def test_rejects_destructive_and_unrecognized_plans(self):
        for plan in ["Delete Files", "Replace goblinAuth", "Destroy Web", "partial output"]:
            with self.assertRaises(RuntimeError):
                safe_plan(plan)
        for plan in ["No changes", "Create Web", "Update Web", "Plan: 3 to create, 23 binding changes", "[Web] update"]:
            safe_plan(plan)

    def test_retained_private_link_does_not_allow_dirty_source(self):
        require_clean_snapshot(["?? .local"], False)
        for lines, directory in [([" M apps/web/src/worker.ts"], False), (["?? source.ts"], False), (["?? .local"], True)]:
            with self.assertRaises(RuntimeError):
                require_clean_snapshot(lines, directory)

    def test_requires_same_sha_authenticated_and_current_version(self):
        good = {"sha": "a" * 40, "acceptance": "authenticated", "version": "v1"}
        require_dev(good, "a" * 40, "v1")
        for change in [{"sha": "b" * 40}, {"acceptance": "public"}, {"version": "v0"}]:
            with self.assertRaises(RuntimeError):
                require_dev(good | change, "a" * 40, "v1")


    def test_receipt_lists_every_named_resource(self):
        self.assertEqual(resources("dev", "db-1"), {"worker": "goblin-dev", "auth": "db-1",
                                                    "files": "goblin-dev-files", "flows": "goblin-dev-flows"})

    def test_prunes_only_checkouts_no_stage_runs(self):
        dev, prod, old = "a" * 40, "b" * 40, "c" * 40
        self.assertEqual(stale_checkouts([dev, prod, old, "notes", "d" * 39], {dev, prod}), [old])
        self.assertEqual(stale_checkouts([dev], {dev, None}), [])

    def test_only_the_first_prod_release_must_be_invite_only(self):
        from release import require_signup

        require_signup({"GOBLIN_SIGNUP_MODE": "invite"}, False)
        require_signup({"GOBLIN_SIGNUP_MODE": "open"}, True)
        for mode in ["open", "closed", None]:
            with self.assertRaises(RuntimeError):
                require_signup({} if mode is None else {"GOBLIN_SIGNUP_MODE": mode}, False)

if __name__ == "__main__":
    unittest.main()
