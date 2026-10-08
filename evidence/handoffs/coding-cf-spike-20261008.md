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
