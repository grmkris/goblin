"""Deploy and verify one exact, checked commit of goblin on dev or prod, from the deploy job's own checkout.

`python3 -B scripts/release.py dev|prod <full-sha>`: CI's Deploy dev and Deploy prod jobs run it after Check
(.github/workflows/ci.yml); from anywhere else it is break-glass (`GOBLIN_BREAK_GLASS=1`, scripts/stage.ts).
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = "grmkris/goblin"
WORKFLOW = "ci.yml"
ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / ".local"
SHA = re.compile(r"[a-f0-9]{40}")
# Stateful resources every stage already has. A plan that would create one has lost its state: deploying it would
# orphan the live resource (D1 holds every account) or fail half way.
STATEFUL = ["goblinAuth", "Files", "Web"]
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def run(args, env=None):
    return subprocess.check_output(args, cwd=ROOT, env=env, text=True)


def gh(path):
    return json.loads(run(["gh", "api", path]))


def envfile(path):
    if path.stat().st_mode & 0o077:
        raise RuntimeError("private_env_requires_mode_600")
    return {k: v.strip().strip('"').strip("'") for line in path.read_text().splitlines()
            if "=" in line and not line.startswith("#") for k, v in [line.split("=", 1)]}


def safe_plan(output):
    # Plan tables label destructive actions Delete/Replace. An unbound binding is one too: unbinding a Durable Object
    # namespace makes Alchemy delete its class and every object's data (`deleted_classes`), and a plan line does not say
    # a binding's kind, so every unbind takes the separate review. Unknown output fails closed. A colour code would hide
    # a word boundary, so it is stripped first.
    plain = ANSI.sub("", output)
    if re.search(r"\b(delete|replace|destroy|unbind)\b", plain, re.I):
        raise RuntimeError("destructive_plan_requires_separate_review")
    if not re.search(r"No changes|Create|Update", plain, re.I):
        raise RuntimeError("unrecognized_plan_output")


def require_existing(output, names):
    # A plan line reads `[<fqn>] <action>`; a binding is `[<fqn>/<binding>]` and does not match.
    plain = ANSI.sub("", output)
    for name in names:
        if re.search(r"\[" + re.escape(name) + r"\]\s+(create|adopted)\b", plain, re.I):
            raise RuntimeError("plan_would_create_existing_resource: " + name)


def require_clean_checkout(lines):
    if any(line not in ["?? .local", "?? .local/"] for line in lines):
        raise RuntimeError("release_checkout_must_be_clean")


def require_dev(receipt, sha, version):
    if receipt.get("sha") != sha or receipt.get("acceptance") != "authenticated" or receipt.get("version") != version:
        raise RuntimeError("prod_requires_current_authenticated_dev_of_same_sha")


def require_check(runs, jobs, sha, branch):
    """The ci.yml run pushed to `branch` at `sha` whose job `Check` succeeded, even while the run is still going."""
    for item in runs:
        if (item.get("head_sha") == sha and item.get("head_branch") == branch and item.get("event") == "push"
                and any(job.get("name") == "Check" and job.get("conclusion") == "success" for job in jobs(item["id"]))):
            return item
    raise RuntimeError("successful_dev_check_for_exact_sha_required")


def require_ref(stage, sha, dev_sha, prod_sha):
    if stage == "dev" and sha != dev_sha:
        raise RuntimeError("superseded_dev_commit")
    if stage == "prod" and sha != prod_sha:
        raise RuntimeError("prod_ref_must_equal_release_sha")


def require_fast_forward(status):
    if status not in ["ahead", "identical"]:
        raise RuntimeError("promotion_must_fast_forward")


def prod_push(env):
    """The prod tip before this push, which must be a real commit, and a push that was not forced."""
    before = env.get("GOBLIN_PROD_BEFORE", "")
    if not SHA.fullmatch(before) or before == "0" * 40:
        raise RuntimeError("prod_push_before_sha_required")
    if env.get("GOBLIN_PROD_FORCED") == "true":
        raise RuntimeError("prod_push_must_not_be_forced")
    return before


def acceptance_run(runs, sha):
    """The successful ci.yml push run on dev at `sha`: Check and Deploy dev both passed, so it holds the receipt."""
    for item in runs:
        if (item.get("head_sha") == sha and item.get("head_branch") == "dev" and item.get("event") == "push"
                and item.get("conclusion") == "success"):
            return item
    raise RuntimeError("successful_dev_deploy_for_exact_sha_required")


def pick_database(databases, name):
    # The list endpoint's `name` filter is a search; only an exact, single match is the stage's database.
    matches = [item for item in databases if item.get("name") == name and item.get("uuid")]
    if len(matches) != 1:
        raise RuntimeError("single_d1_database_named_" + name + "_required")
    return matches[0]["uuid"]


def ref(branch):
    return gh(f"repos/{REPO}/git/ref/heads/{branch}")["object"]["sha"]


def compare(base, head):
    return gh(f"repos/{REPO}/compare/{base}...{head}")["status"]


def merged_runs(listings):
    """The runs of several listings, each once by id, in the order first seen."""
    seen = {}
    for listing in listings:
        for item in listing:
            seen.setdefault(item.get("id"), item)
    return list(seen.values())


def runs_of(sha, branch, limit=100):
    """
    The ci.yml runs that may be `sha`'s push on `branch`, asked two ways and merged, each with one filter: GitHub's
    listing has answered some combinations of filters with nothing while others worked (2026-10-22). Callers match
    `sha`, branch and event on every run, so neither listing alone decides.
    """
    base = f"repos/{REPO}/actions/workflows/{WORKFLOW}/runs"
    by_sha = gh(f"{base}?head_sha={sha}&per_page={limit}")["workflow_runs"]
    by_branch = gh(f"{base}?branch={branch}&per_page={limit}")["workflow_runs"]
    return merged_runs([by_sha, by_branch])


def runs(sha):
    return runs_of(sha, "dev")


def jobs(run_id):
    # The latest attempt's jobs: a re-run's Check counts, the attempt it replaced does not.
    return gh(f"repos/{REPO}/actions/runs/{run_id}/jobs?filter=latest&per_page=100")["jobs"]


def checked_source(stage, sha):
    check = require_check(runs(sha), jobs, sha, "dev")
    require_ref(stage, sha, ref("dev"), ref("prod") if stage == "prod" else None)
    if compare(sha, "dev") not in ["ahead", "identical"]:
        raise RuntimeError("dev_ancestor_required")
    return check


def dev_acceptance(sha):
    """The `dev-acceptance` receipt of the successful dev deploy of `sha`, from its CI artifact."""
    item = acceptance_run(runs(sha), sha)
    with tempfile.TemporaryDirectory(prefix="goblin-dev-acceptance-") as directory:
        run(["gh", "run", "download", str(item["id"]), "--repo", REPO, "--name", "dev-acceptance", "--dir", directory])
        return json.loads((Path(directory) / "dev.json").read_text())


def cloud_env():
    return Path(os.environ.get("GOBLIN_CLOUD_ENV_FILE") or LOCAL / "cloud.env")


def cloud_config():
    return envfile(cloud_env())


def stage_config(stage):
    return cloud_config() | envfile(LOCAL / (stage + ".env"))


def directories(env):
    """Where sanitized receipts and private step logs go: CI points them at the runner's temp directory."""
    receipts = Path(env.get("GOBLIN_RECEIPTS_DIR") or LOCAL / "receipts")
    logs = Path(env.get("GOBLIN_LOG_DIR") or LOCAL / "release-logs")
    for path in [receipts, logs]:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return receipts, logs


def resources(stage, auth_database):
    # The stage's named Cloudflare resources (apps/web/alchemy.run.ts), as the receipt lists them.
    prefix = "goblin-" + stage
    return {"worker": prefix, "auth": auth_database, "files": prefix + "-files", "flows": prefix + "-flows"}


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


def deployments(config, worker):
    data = cloud(config, "/workers/scripts/" + worker + "/deployments")
    return data.get("deployments", []) if isinstance(data, dict) else data


def version(config, stage, stack="goblin"):
    found = deployments(config, stack + "-" + stage)
    versions = found[0].get("versions", []) if found else []
    if len(versions) != 1 or versions[0].get("percentage") != 100:
        raise RuntimeError("single_active_worker_version_required")
    return versions[0]["version_id"]


def released(config, stage):
    """Whether the stage's Worker serves any version yet: the first release is the one without."""
    try:
        found = deployments(config, "goblin-" + stage)
    except RuntimeError as error:
        if str(error) == "cloudflare_http_404":
            return False
        raise
    return bool(found and found[0].get("versions"))


def tail(text, count=40):
    return "\n".join(text.splitlines()[-count:])


def failure_reason(text):
    # A failed smoke writes its machine reason near the top of its JSON, which the 40-line tail cuts off.
    match = re.search(r'^\s*"reason":\s*"([^"\n]{1,300})"', text, re.MULTILINE)
    return match.group(1) if match else None


def execute(command, env, log):
    log.touch(mode=0o600)
    with log.open("w") as handle:
        result = subprocess.run(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                stdout=handle, stderr=subprocess.STDOUT)
    if result.returncode:
        # CI masks every stage secret of eight or more characters before this prints (scripts/ci_credentials.py).
        text = log.read_text()
        reason = failure_reason(text)
        print(f"--- last 40 lines of {log.name} ---\n{tail(text)}\n---" + (f"\nreason: {reason}" if reason else ""), flush=True)
        raise RuntimeError("release_step_failed: " + log.name)
    return log.read_text()


# Right after a deploy the agents' Durable Objects run the old code for some minutes, and a request may meet one being
# replaced (a closed socket, or an answer the new contract cannot read): the smoke tries again before the release fails.
SMOKE_TRIES = 3
SMOKE_WAIT_SECONDS = 240


def smoke_until_settled(command, env, log_of, wait=time.sleep):
    """Runs the smoke up to SMOKE_TRIES times, `log_of(try)` naming each try's log; the last failure stands."""
    for attempt in range(1, SMOKE_TRIES + 1):
        try:
            return execute(command, env, log_of(attempt))
        except RuntimeError:
            if attempt == SMOKE_TRIES:
                raise
            print(f"smoke failed; trying again in {SMOKE_WAIT_SECONDS} s ({attempt + 1} of {SMOKE_TRIES})", flush=True)
            wait(SMOKE_WAIT_SECONDS)


def require_release_checkout(sha):
    if run(["git", "rev-parse", "HEAD"]).strip() != sha:
        raise RuntimeError("release_checkout_sha_mismatch")
    require_clean_checkout(run(["git", "status", "--porcelain"]).splitlines())


def require_signup(config, released_before):
    # The first prod release is invite-only; later ones may open sign-up (owner, 2026-10-12: open, with a free plan).
    if config.get("GOBLIN_SIGNUP_MODE") != "invite" and not released_before:
        raise RuntimeError("first_prod_release_must_be_invite_only")


def release(stage, sha):
    if not SHA.fullmatch(sha):
        raise RuntimeError("full_commit_sha_required")
    if stage == "prod" and os.environ.get("GOBLIN_CONFIRM_PROD") != "1":
        raise RuntimeError("prod_requires_GOBLIN_CONFIRM_PROD=1")
    check = checked_source(stage, sha)
    config = stage_config(stage)
    if stage == "prod":
        require_fast_forward(compare(prod_push(os.environ), sha))
        require_dev(dev_acceptance(sha), sha, version(config, "dev"))
        require_signup(config, released(config, "prod"))
    require_release_checkout(sha)
    receipts, logs = directories(os.environ)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    prefix = f"{stamp}-{stage}-{sha[:12]}"
    env = dict(os.environ, GOBLIN_STAGE=stage, GOBLIN_ENV_DIR=str(LOCAL), GOBLIN_CLOUD_ENV_FILE=str(cloud_env()),
               ALCHEMY_PLAIN="1", CI="true")
    execute(["bun", "install", "--frozen-lockfile"], env, logs / f"{prefix}-install.log")
    plan = execute(["bun", "run", "plan:" + stage], env, logs / f"{prefix}-plan.log")
    expected = sorted(p.name for p in (ROOT / "apps/runtime/migrations").glob("*.sql"))
    safe_plan(plan)
    require_existing(plan, STATEFUL)
    print(stage + ": non-destructive plan verified", flush=True)
    execute(["bun", "run", "deploy:" + stage], env, logs / f"{prefix}-deploy.log")
    print(stage + ": deployed; verifying smoke and drift", flush=True)
    # The smoke's flows check reads Analytics Engine with the stage's Cloudflare credentials.
    smoke_env = env | {key: config[key] for key in ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]}
    smoke_until_settled(["bun", "--env-file", str(LOCAL / (stage + ".env")), "scripts/smoke-dev.ts"], smoke_env,
                        lambda attempt: logs / (f"{prefix}-smoke.log" if attempt == 1 else f"{prefix}-smoke-{attempt}.log"))
    drift = execute(["bun", "run", "drift:" + stage], env, logs / f"{prefix}-drift.log")
    if not any(line.startswith("{") and json.loads(line).get("drift") == "verified" for line in drift.splitlines()):
        raise RuntimeError("drift_not_clean")
    smoke = json.loads((LOCAL / f"smoke-{stage}-receipt.json").read_text())
    if smoke.get("status") != "passed" or smoke.get("stage") != stage:
        raise RuntimeError("stage_smoke_required")
    acceptance = "public" if smoke.get("mode") == "read-only" else "authenticated"
    if stage == "dev" and acceptance != "authenticated":
        raise RuntimeError("dev_requires_authenticated_smoke")
    auth = f"goblin-{stage}-auth"
    db = pick_database(cloud(config, "/d1/database?name=" + urllib.parse.quote(auth)), auth)
    migrations = cloud(config, f"/d1/database/{db}/query", {"sql": "SELECT name FROM __alchemy_migrations ORDER BY id"})
    names = [row["name"] for result in migrations for row in result.get("results", [])]
    if sorted(names) != expected:
        raise RuntimeError("migration_inventory_mismatch")
    receipt = {"utc": stamp, "stage": stage, "sha": sha, "ci": check["html_url"],
               "version": version(config, stage), "acceptance": acceptance, "drift": "verified",
               "providerNormalizations": ["Web.domain.zone bookkeeping", "D1 default disabled replication"],
               "migrations": names, "resources": resources(stage, db)}
    # No content, credentials, owner identity, or provider token enters this receipt.
    (receipts / f"{stage}.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["dev", "prod"])
    parser.add_argument("sha")
    args = parser.parse_args()
    try:
        release(args.stage, args.sha)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error))
        raise SystemExit(1) from None
