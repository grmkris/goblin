"""Promote an exact green commit with private persistent state and bounded receipts."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

REPO = "grmkris/goblin"
ROOT = Path(__file__).resolve().parent.parent
STATE = Path(os.environ.get("GOBLIN_RELEASE_ROOT", "/var/lib/goblin-release"))


def run(args, cwd=ROOT, env=None):
    if args[0] == "git" and cwd != ROOT:
        args = ["git", "-c", "safe.directory=" + str(cwd), *args[1:]]
    return subprocess.check_output(args, cwd=cwd, env=env, text=True)


def envfile(path):
    if path.stat().st_mode & 0o077:
        raise RuntimeError("private_env_requires_mode_600")
    return {k: v.strip().strip('"').strip("'") for line in path.read_text().splitlines()
            if "=" in line and not line.startswith("#") for k, v in [line.split("=", 1)]}


def safe_plan(output):
    # Plan tables label destructive actions Delete/Replace. Unknown output fails closed.
    if re.search(r"\b(delete|replace|destroy)\b", output, re.I):
        raise RuntimeError("destructive_plan_requires_separate_review")
    if not re.search(r"No changes|Create|Update", output, re.I):
        raise RuntimeError("unrecognized_plan_output")


def require_dev(receipt, sha, version):
    if receipt.get("sha") != sha or receipt.get("acceptance") != "authenticated" or receipt.get("version") != version:
        raise RuntimeError("prod_requires_current_authenticated_dev_of_same_sha")


def cloud(config, path, body=None):
    account = config["CLOUDFLARE_ACCOUNT_ID"]
    url = "https://api.cloudflare.com/client/v4/accounts/" + account + path
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                    headers={"Authorization": "Bearer " + config["CLOUDFLARE_API_TOKEN"],
                                             "Content-Type": "application/json"})
    try:
        data = json.load(urllib.request.urlopen(request, timeout=60))
    except urllib.error.HTTPError as error:
        raise RuntimeError("cloudflare_http_" + str(error.code)) from None
    if not data.get("success"):
        raise RuntimeError("cloudflare_request_failed")
    return data["result"]


def version(config, stage):
    data = cloud(config, "/workers/scripts/goblin-" + stage + "/deployments")
    deployments = data.get("deployments", []) if isinstance(data, dict) else data
    versions = deployments[0].get("versions", []) if deployments else []
    if len(versions) != 1 or versions[0].get("percentage") != 100:
        raise RuntimeError("single_active_worker_version_required")
    return versions[0]["version_id"]


def execute(command, snapshot, env, log):
    with log.open("w") as handle:
        result = subprocess.run(command, cwd=snapshot, env=env, stdin=subprocess.DEVNULL,
                                stdout=handle, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError("release_step_failed: " + log.name)
    return log.read_text()


def release(stage, sha):
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise RuntimeError("full_commit_sha_required")
    if stage == "prod" and os.environ.get("GOBLIN_CONFIRM_PROD") != "1":
        raise RuntimeError("prod_requires_GOBLIN_CONFIRM_PROD=1")
    runs = json.loads(run(["gh", "api", f"repos/{REPO}/actions/workflows/check.yml/runs?head_sha={sha}&event=push&per_page=100"]))
    checks = [x for x in runs["workflow_runs"] if x["head_sha"] == sha and x["head_branch"] == "main"
              and x["conclusion"] == "success"]
    if not checks:
        raise RuntimeError("successful_main_check_for_exact_sha_required")
    if json.loads(run(["gh", "api", f"repos/{REPO}/compare/{sha}...main"]))["status"] not in ["ahead", "identical"]:
        raise RuntimeError("main_ancestor_required")
    config_dir = Path(os.environ.get("GOBLIN_ENV_DIR", str(ROOT / ".local"))).resolve()
    shared = Path(os.environ.get("GOBLIN_CLOUD_ENV_FILE", str(Path.home() / ".config/myapps/dev.env")))
    config = envfile(shared) | envfile(config_dir / (stage + ".env"))
    if stage == "prod":
        receipt = json.loads((STATE / "receipts/dev.json").read_text())
        require_dev(receipt, sha, version(config, "dev"))
        if config.get("GOBLIN_SIGNUP_MODE") != "invite":
            raise RuntimeError("first_prod_release_must_be_invite_only")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    prefix = STATE / "logs" / f"{stamp}-{stage}-{sha[:12]}"
    env = dict(os.environ, GOBLIN_STAGE=stage, GOBLIN_ENV_DIR=str(config_dir),
               GOBLIN_CLOUD_ENV_FILE=str(shared), ALCHEMY_PLAIN="1", CI="true")
    checkouts = STATE / "checkouts"
    checkouts.mkdir(parents=True, exist_ok=True)
    snapshot = checkouts / sha
    if not snapshot.exists():
        run(["git", "clone", "--quiet", "--no-hardlinks", "--no-checkout", str(ROOT), str(snapshot)])
        run(["git", "checkout", "--quiet", "--detach", sha], cwd=snapshot)
    elif run(["git", "rev-parse", "HEAD"], cwd=snapshot).strip() != sha:
        raise RuntimeError("release_checkout_sha_mismatch")
    if run(["git", "status", "--porcelain"], cwd=snapshot).strip():
        raise RuntimeError("release_checkout_must_be_clean")
    local_link = snapshot / ".local"
    if local_link.exists() or local_link.is_symlink():
        local_link.unlink()
    local_link.symlink_to(config_dir, target_is_directory=True)
    execute(["bun", "install", "--frozen-lockfile"], snapshot, env, Path(str(prefix) + "-install.log"))
    plan = execute(["bun", "run", "plan:" + stage], snapshot, env, Path(str(prefix) + "-plan.log"))
    expected = sorted(p.name for p in (snapshot / "apps/runtime/migrations").glob("*.sql"))
    safe_plan(plan)
    print(stage + ": non-destructive plan verified", flush=True)
    execute(["bun", "run", "deploy:" + stage], snapshot, env, Path(str(prefix) + "-deploy.log"))
    print(stage + ": deployed; verifying smoke and drift", flush=True)
    execute(["bun", "--env-file", str(config_dir / (stage + ".env")), "scripts/smoke-dev.ts"],
            snapshot, env, Path(str(prefix) + "-smoke.log"))
    drift = execute(["bun", "run", "drift:" + stage], snapshot, env, Path(str(prefix) + "-drift.log"))
    if not any(line.startswith("{") and json.loads(line).get("drift") == "verified" for line in drift.splitlines()):
        raise RuntimeError("drift_not_clean")
    smoke = json.loads((config_dir / f"smoke-{stage}-receipt.json").read_text())
    if smoke.get("status") != "passed" or smoke.get("stage") != stage:
        raise RuntimeError("stage_smoke_required")
    acceptance = "public" if smoke.get("mode") == "read-only" else "authenticated"
    if stage == "dev" and acceptance != "authenticated":
        raise RuntimeError("dev_requires_authenticated_smoke")
    state = STATE / "alchemy/state/goblin" / stage
    db = json.loads((state / "goblinAuth.json").read_text())["attr"]["databaseId"]
    migrations = cloud(config, f"/d1/database/{db}/query", {"sql": "SELECT name FROM __alchemy_migrations ORDER BY id"})
    names = [row["name"] for result in migrations for row in result.get("results", [])]
    if sorted(names) != expected:
        raise RuntimeError("migration_inventory_mismatch")
    receipt = {"utc": stamp, "stage": stage, "sha": sha, "ci": checks[0]["html_url"],
               "version": version(config, stage), "acceptance": acceptance,
               "drift": "verified", "providerNormalizations": ["Web.domain.zone bookkeeping", "D1 default disabled replication"], "migrations": names,
               "resources": {"worker": "goblin-" + stage, "auth": db, "files": "goblin-" + stage + "-files"}}
    # No content, credentials, owner identity, or provider token enters this receipt.
    for path in [STATE / f"receipts/{stage}.json", STATE / f"receipts/{stamp}-{stage}-{sha[:12]}.json"]:
        path.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["dev", "prod"])
    parser.add_argument("sha")
    args = parser.parse_args()
    os.umask(0o007)
    if os.environ.get("GOBLIN_STAGE_LOCK_HELD") != str(STATE):
        os.execvpe("flock", ["flock", "-x", str(STATE / "deploy.lock"), "python3", __file__, args.stage, args.sha],
                  dict(os.environ, GOBLIN_STAGE_LOCK_HELD=str(STATE)))
    try:
        release(args.stage, args.sha)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error))
        raise SystemExit(1) from None
