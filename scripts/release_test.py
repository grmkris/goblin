"""Fail-closed checks for promotion, independent of credentials and Cloudflare."""
import unittest
from release import require_clean_snapshot, require_dev, safe_plan, stale_checkouts


class PromotionTest(unittest.TestCase):
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


    def test_prunes_only_checkouts_no_stage_runs(self):
        dev, prod, old = "a" * 40, "b" * 40, "c" * 40
        self.assertEqual(stale_checkouts([dev, prod, old, "notes", "d" * 39], {dev, prod}), [old])
        self.assertEqual(stale_checkouts([dev], {dev, None}), [])

if __name__ == "__main__":
    unittest.main()
