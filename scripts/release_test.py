"""Fail-closed checks for promotion, independent of credentials and Cloudflare."""
import unittest
from release import require_dev, safe_plan


class PromotionTest(unittest.TestCase):
    def test_rejects_destructive_and_unrecognized_plans(self):
        for plan in ["Delete Files", "Replace goblinAuth", "Destroy Web", "partial output"]:
            with self.assertRaises(RuntimeError):
                safe_plan(plan)
        for plan in ["No changes", "Create Web", "Update Web", "Plan: 3 to create, 23 binding changes", "[Web] update"]:
            safe_plan(plan)

    def test_requires_same_sha_authenticated_and_current_version(self):
        good = {"sha": "a" * 40, "acceptance": "authenticated", "version": "v1"}
        require_dev(good, "a" * 40, "v1")
        for change in [{"sha": "b" * 40}, {"acceptance": "public"}, {"version": "v0"}]:
            with self.assertRaises(RuntimeError):
                require_dev(good | change, "a" * 40, "v1")


if __name__ == "__main__":
    unittest.main()
