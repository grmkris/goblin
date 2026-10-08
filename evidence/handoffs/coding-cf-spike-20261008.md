# Cloudflare coding verifier spike — 2026-10-08

The second coding runner uses a Cloudflare Worker plus one Cloudflare Container per verification job. The Worker is
`https://goblin-coding-cf-dev.kristjan-grm11775.workers.dev` in the Goblin Cloudflare account. The Alchemy stack is
dev-only (`goblin-coding-cf-dev`); the container image is a frozen Goblin snapshot with dependencies installed.
`enableInternet` is false. GitHub, model, Cloudflare and host credentials stay outside the container.

The trusted coding MCP host can select this runner through a private `runner` configuration field. The host keeps OAuth,
GitHub publication and session state; only a bounded source overlay crosses the Worker boundary. Verification reuses the
job container's compiler processes. Fixed `goblin hello` execution runs in a separate container and is destroyed after
the response. The parallel service used a separate OAuth state directory, loopback port and temporary tunnel:
`https://covering-eminem-switch-commentary.trycloudflare.com/mcp`.

## Comparison

The deployed comparison used the same base `322e22853e4c2b1350d9511e1f489b21b474277e` and the existing Hello World
fixture. Native Netcup and Cloudflare returned the same revisions and diagnostics for an invalid edit, the corrected edit,
and two warm checks. The invalid edit produced two diagnostics and every corrected check passed. Cloudflare wall times
were 3.6 s, 6.6 s, 7.1 s and 8.2 s; native verifier times were 4.8 s, 3.9 s, 3.5 s and 3.3 s. Cloudflare execution
returned `Hello, world!\n` with exit code 0. The private receipt is `.local/coding-cf-spike/comparison-cloudflare.json`.

## Goblin chat acceptance

The parallel service was connected to Goblin dev with DCR/OAuth PKCE and exactly the seven coding tools. The dedicated
chat was [Cloudflare coding spike: Hello World PR](https://dev.goblin.surf/c/4358), with other connections, skills and
subagents disabled. Goblin created [draft PR #2](https://github.com/grmkris/goblin/pull/2), head
`aceec53cae650e9061859ecc18a8503bc42f2a9b`, from the same base. Its submitted revision passed Cloudflare static
verification with zero diagnostics. An operator then verified the exact PR source in Cloudflare and executed it:
`Hello, world!\n`, exit code 0. The private proof is `.local/coding-cf-spike/pr-proof.json`.

The PR is draft-only and was not merged or deployed. GitHub CI was still in progress when this receipt was recorded.
The full shared-checkout gate also reached an unrelated existing Knip finding in
`apps/web/test/browser/question-app.ts`; the spike's own typecheck, formatting, Oxlint, 13 tests and deployed
comparison passed.

The Worker remains deployed for follow-up comparison. The temporary Cloudflare-backed MCP server and tunnel are owned
tmux sessions `goblin-coding-cf-spike` and `goblin-coding-cf-spike-tunnel`; its private configuration and OAuth state
are under `.local/coding-cf-spike/mcp` and are not committed.

## Final receipt

- Spike implementation committed on main as `10a3c14` (18 exact owned files). No shared-main push or standard Goblin
  release was performed by this lane.
- Exact PR head CI completed successfully: [run 37826957190](https://github.com/grmkris/goblin/actions/runs/37826957190)
  ran `bun run check`, including 17 passing CLI tests across four files. This proves the generated PR against its
  frozen baseline; it does not prove the infrastructure spike's separate main commit.
- The live chat's `coding_ready` returned zero diagnostics in 12,410 ms for revision
  `613335bfc8a7f9036f25bb610a44535de1830b5e0a08442b479e7fe5ed7cddb6`. The exact-head operator verification passed
  again in 13,839 ms at that same revision; Cloudflare execution printed exactly `Hello, world!\n`, with empty stderr
  and exit code 0. The PR preserves `main.ts`'s 100755 mode.
- The parallel coding service returned health 200 with zero retained sessions and refused unauthenticated MCP with 401.
- The existing Netcup service remained available. Its operator authorization key was rotated and reloaded; neither
  operator authorization key nor runner credentials are part of this evidence or any commit.
- Root `check:fast` passed. The App lane fixed the unrelated Knip fixture in `256a96b` after this lane's full-gate
  attempt; the App release owner will run combined candidate acceptance. Foreign files were preserved throughout.
- This remains an operator spike on `grmkris/goblin` using host `gh` as `grmkris`. Generic repository linking,
  GitHub App installation credentials, tenant-derived container identity and browser acceptance are future work.
