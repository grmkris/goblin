"""Promote one accepted dev SHA without relying on a bot push to trigger deployment."""
import argparse
import json
import os
import re
import subprocess
from release import REPO, STATE, checked_source, ref, release, require_dev, run, stage_config, version
from wallet_release import config as wallet_config, deploy_wallet


def require_fast_forward(status):
    if status not in ["ahead", "identical"]:
        raise RuntimeError("promotion_must_fast_forward")


def promote(sha):
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise RuntimeError("full_commit_sha_required")
    checked_source("dev", sha)
    wallet_config()  # Fail before advancing prod if Wallet credentials are absent or target another stage.
    _, _, config = stage_config("prod")
    receipt = json.loads((STATE / "receipts/dev.json").read_text())
    require_dev(receipt, sha, version(config, "dev"))
    previous = ref("prod")
    comparison = json.loads(run(["gh", "api", f"repos/{REPO}/compare/{previous}...{sha}"]))
    require_fast_forward(comparison["status"])
    run(["gh", "api", "--method", "PATCH", f"repos/{REPO}/git/refs/heads/prod", "-f", "sha=" + sha, "-F", "force=false"])
    release("prod", sha)
    deploy_wallet(sha)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("sha")
    args = parser.parse_args()
    os.umask(0o007)
    if os.environ.get("GOBLIN_STAGE_LOCK_HELD") != str(STATE):
        os.execvpe("flock", ["flock", "-x", str(STATE / "deploy.lock"), "python3", __file__, args.sha],
                  dict(os.environ, GOBLIN_STAGE_LOCK_HELD=str(STATE)))
    os.environ["GOBLIN_CONFIRM_PROD"] = "1"
    try:
        promote(args.sha)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error))
        raise SystemExit(1) from None
