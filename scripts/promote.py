"""Pre-flight one accepted dev SHA for production, then fast-forward `prod`; CI's Deploy prod job deploys it.

`bun run promote <full-sha>` (any machine with `gh` signed in to the repository and `.local/cloud.env`). It deploys
nothing and needs no prod credentials: Deploy prod repeats every check before it touches production.
"""
import argparse
import subprocess
import time

from release import (REPO, SHA, WORKFLOW, checked_source, cloud_config, compare, dev_acceptance, gh, ref, require_dev,
                     require_fast_forward, run, version)


class GitHub:
    """The real checks and the one write, against GitHub and Cloudflare."""

    def source(self, sha):
        checked_source('dev', sha)

    def acceptance(self, sha):
        return dev_acceptance(sha)

    def dev_version(self):
        return version(cloud_config(), 'dev')

    def fast_forward(self, sha):
        return compare(ref('prod'), sha)

    def move_prod(self, sha):
        run(['gh', 'api', '--method', 'PATCH', f'repos/{REPO}/git/refs/heads/prod', '-f', 'sha=' + sha,
             '-F', 'force=false'])

    def deploy_run(self, sha):
        # Best effort: the push run takes a few seconds to appear.
        for _ in range(10):
            found = gh(f'repos/{REPO}/actions/workflows/{WORKFLOW}/runs?head_sha={sha}&event=push&branch=prod')
            if found['workflow_runs']:
                return found['workflow_runs'][0]['html_url']
            time.sleep(3)
        return f'https://github.com/{REPO}/actions/workflows/{WORKFLOW}?query=branch%3Aprod'


def promote(sha, github):
    """Every check first, in order; `prod` moves only when all of them pass."""
    if not SHA.fullmatch(sha):
        raise RuntimeError('full_commit_sha_required')
    github.source(sha)
    require_dev(github.acceptance(sha), sha, github.dev_version())
    require_fast_forward(github.fast_forward(sha))
    github.move_prod(sha)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('sha')
    args = parser.parse_args()
    github = GitHub()
    try:
        promote(args.sha, github)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error))
        raise SystemExit(1) from None
    print('prod moved to ' + args.sha + '; Deploy prod: ', end='', flush=True)
    try:
        print(github.deploy_run(args.sha))
    except (RuntimeError, subprocess.CalledProcessError, KeyError, ValueError):
        print(f'https://github.com/{REPO}/actions/workflows/{WORKFLOW}?query=branch%3Aprod')
