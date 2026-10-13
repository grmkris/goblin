"""Fail-closed checks for releases, independent of credentials and Cloudflare."""
from pathlib import Path
import tempfile
import unittest
from release import (acceptance_run, directories, pick_database, prod_push, require_check,
                     require_clean_checkout, require_dev, require_existing, require_fast_forward, require_ref,
                     require_signup, resources, safe_plan, tail)

A, B = "a" * 40, "b" * 40


class ReleaseTest(unittest.TestCase):
    def test_only_a_passed_check_job_of_the_exact_dev_push_is_accepted(self):
        good = {"id": 1, "head_sha": A, "head_branch": "dev", "event": "push", "conclusion": None}
        jobs = {1: [{"name": "Check", "conclusion": "success"}, {"name": "Deploy dev", "conclusion": None}]}
        # The deploy job asks while its own run is still in progress: the run has no conclusion yet.
        self.assertEqual(require_check([good], jobs.get, A, "dev"), good)
        for change in [{"head_sha": B}, {"head_branch": "prod"}, {"event": "pull_request"}]:
            with self.assertRaises(RuntimeError):
                require_check([good | change], jobs.get, A, "dev")
        for listed in [[{"name": "Check", "conclusion": "failure"}], [{"name": "Check", "conclusion": None}],
                       [{"name": "Deploy dev", "conclusion": "success"}], []]:
            with self.assertRaises(RuntimeError):
                require_check([good], {1: listed}.get, A, "dev")

    def test_branch_targets_reject_stale_dev_and_different_prod(self):
        require_ref("dev", A, A, None)
        require_ref("prod", A, B, A)
        for stage, dev, prod in [("dev", B, None), ("prod", A, B)]:
            with self.assertRaises(RuntimeError):
                require_ref(stage, A, dev, prod)

    def test_rejects_destructive_and_unrecognized_plans(self):
        for plan in ["Delete Files", "Replace goblinAuth", "Destroy Web", "partial output",
                     "[Files] \x1b[38;2;255;0;0mdelete\x1b[0m"]:
            with self.assertRaises(RuntimeError):
                safe_plan(plan)
        for plan in ["No changes", "Create Web", "Update Web", "Plan: 3 to create, 23 binding changes", "[Web] update"]:
            safe_plan(plan)

    def test_rejects_a_plan_that_would_create_a_stateful_resource_again(self):
        names = ["goblinAuth", "Files", "Web"]
        for plan in ["[goblinAuth] create", "Plan: 1 to create\n[Files] create", "[Web] adopted",
                     "\x1b[36m[Web]\x1b[0m \x1b[32mcreate\x1b[0m", "[12:00:00.000] INFO (#1): [goblinAuth] create"]:
            with self.assertRaisesRegex(RuntimeError, "plan_would_create_existing_resource"):
                require_existing(plan, names)
        for plan in ["[Web] update\n[Web/FILES] create\n[Flows] create", "[goblinAuth] noop", "Plan: no changes",
                     "[WebExtra] create"]:
            require_existing(plan, names)

    def test_only_a_clean_checkout_with_private_config_may_release(self):
        require_clean_checkout([])
        require_clean_checkout(["?? .local"])
        require_clean_checkout(["?? .local/"])
        for lines in [[" M apps/web/src/worker.ts"], ["?? source.ts"], ["?? .local/", "?? .alchemy/"]]:
            with self.assertRaises(RuntimeError):
                require_clean_checkout(lines)

    def test_requires_same_sha_authenticated_and_current_version(self):
        good = {"sha": A, "acceptance": "authenticated", "version": "v1"}
        require_dev(good, A, "v1")
        for change in [{"sha": B}, {"acceptance": "public"}, {"version": "v0"}]:
            with self.assertRaises(RuntimeError):
                require_dev(good | change, A, "v1")

    def test_dev_acceptance_comes_from_a_successful_dev_push_of_the_same_sha(self):
        good = {"id": 7, "head_sha": A, "head_branch": "dev", "event": "push", "conclusion": "success"}
        self.assertEqual(acceptance_run([good | {"conclusion": "failure"}, good], A), good)
        for change in [{"head_sha": B}, {"head_branch": "prod"}, {"event": "workflow_dispatch"},
                       {"conclusion": None}, {"conclusion": "cancelled"}]:
            with self.assertRaises(RuntimeError):
                acceptance_run([good | change], A)

    def test_prod_moves_only_by_fast_forward(self):
        for status in ["ahead", "identical"]:
            require_fast_forward(status)
        for status in ["behind", "diverged", "", None]:
            with self.assertRaises(RuntimeError):
                require_fast_forward(status)
        self.assertEqual(prod_push({"GOBLIN_PROD_BEFORE": B, "GOBLIN_PROD_FORCED": "false"}), B)
        for env in [{}, {"GOBLIN_PROD_BEFORE": "0" * 40}, {"GOBLIN_PROD_BEFORE": B[:12]},
                    {"GOBLIN_PROD_BEFORE": B, "GOBLIN_PROD_FORCED": "true"}]:
            with self.assertRaises(RuntimeError):
                prod_push(env)

    def test_finds_the_auth_database_by_exact_name_only(self):
        listed = [{"name": "goblin-dev-auth-old", "uuid": "u0"}, {"name": "goblin-dev-auth", "uuid": "u1"}]
        self.assertEqual(pick_database(listed, "goblin-dev-auth"), "u1")
        for databases in [[], listed[:1], listed + [{"name": "goblin-dev-auth", "uuid": "u2"}],
                          [{"name": "goblin-dev-auth"}]]:
            with self.assertRaises(RuntimeError):
                pick_database(databases, "goblin-dev-auth")

    def test_receipt_lists_every_named_resource(self):
        self.assertEqual(resources("dev", "db-1"), {"worker": "goblin-dev", "auth": "db-1",
                                                    "files": "goblin-dev-files", "flows": "goblin-dev-flows"})

    def test_receipts_and_logs_go_where_the_job_says(self):
        with tempfile.TemporaryDirectory(prefix="goblin-release-test-") as temporary:
            receipts, logs = directories({"GOBLIN_RECEIPTS_DIR": temporary + "/r", "GOBLIN_LOG_DIR": temporary + "/l"})
            self.assertEqual((receipts, logs), (Path(temporary) / "r", Path(temporary) / "l"))
            self.assertEqual(receipts.stat().st_mode & 0o777, 0o700)
        self.assertEqual(tail("\n".join(str(n) for n in range(100))).splitlines(), [str(n) for n in range(60, 100)])

    def test_only_the_first_prod_release_must_be_invite_only(self):
        require_signup({"GOBLIN_SIGNUP_MODE": "invite"}, False)
        require_signup({"GOBLIN_SIGNUP_MODE": "open"}, True)
        for mode in ["open", "closed", None]:
            with self.assertRaises(RuntimeError):
                require_signup({} if mode is None else {"GOBLIN_SIGNUP_MODE": mode}, False)


if __name__ == "__main__":
    unittest.main()
