# Dev coding spike acceptance — 2026-10-08

The owner authorized a lightweight coding spike, a dev connection and a Hello World draft PR. Implementation lives in
`spikes/coding`, with its package boundary registered in `knip.jsonc`. No Goblin Worker redeployment was needed.

## Live result

- Chat: https://dev.goblin.surf/c/3979 — dedicated thread, other MCP connections and skills switched off, subagents off.
- Draft PR: https://github.com/grmkris/goblin/pull/1 — `goblin hello`, help and four regression cases; three CLI files.
- Final head: `f7e08d04402025425fe4b9814478718e5c16a60f`.
- Frozen baseline: `322e22853e4c2b1350d9511e1f489b21b474277e`.
- Final checked overlay: `56c63968be5635ac6c65602f65176b51933c1947027f8c9bf6c0d5171d358bc0`.
- Two live `coding_ready` calls passed with zero diagnostics, taking 6865 ms and 4740 ms. The second ran after another
  edit, so it proves readiness was invalidated and regained for the new revision.
- Repeating `coding_submit` returned the same PR URL, number and commit. Goblin closed its coding session afterwards.

The live run exposed a `.test.ts` allowlist bug, corrected in `2b324ba`, and review exposed lost executable metadata,
corrected in the publisher in `423f593`. A trusted follow-up Git Data commit repaired only `main.ts`'s mode to 100755;
the source blob `bb08e4d6dcff952fdbc332f0755082e05cfd33ea` stayed unchanged. The agent initially published `b3d2fe4c`.

## Evidence boundaries

- Final spike tests: 11 passed, 0 failed, 43 assertions across five files. Includes real TypeScript/Effect/Oxlint/Oxfmt
  rejection and correction in a virtual new file, publication reconciliation, stale revisions and restart recovery.
- Standalone spike TypeScript, scoped formatting/Oxlint/Knip and Effect checks passed; Effect checked 15 files.
- A shared-checkout full `heavy bun run check` passed during this run before later unrelated agents' edits. This is
  evidence for that point in time, not a claim that the current foreign dirty checkout passes.
- Exact final PR head CI: https://github.com/grmkris/goblin/actions/runs/37815098120 — attempt 2 succeeded through
  `bun run check`, including all 18 CLI tests. Attempt 1 hit auth/owner runtime integration timeouts and connection errors.
- Actual CLI: exact PR source ran under `oven/bun:1.4.2`, as UID 1000, with `--network none`, capabilities dropped,
  read-only source/dependency mounts, no injected credentials, 512 MiB RAM and one CPU. Stdout was `Hello, world!`
  followed by a newline; exit code 0. This was an operator acceptance check; container execution is not an agent tool.
- Public coding service `/health` returned 200 and zero sessions after close; unauthenticated `/mcp` returned 401.

## Operations

Owned tmux sessions `goblin-coding-spike` and `goblin-coding-spike-tunnel` retain the temporary service and tunnel.
Endpoint: https://mini-auburn-damages-charge.trycloudflare.com/mcp.
Dev connection ID: `mini-auburn-damages-charge-trycloudflare-com-fdbaa2`; exactly seven coding tools are granted.
Private config, OAuth state, immutable snapshot and acceptance scripts are under `.local/coding-spike`; owner session
is in `.local/dev-session.json`. Do not print or commit their contents. Server port is loopback 18983.

The final implementation is committed locally on main (`27743e9`, `1d00de6`, `2b324ba`, `423f593`). This session did not
push shared main, merge the draft PR, deploy prod, or touch foreign runtime/UI edits. The live server runs that local
code. A tunnel restart can change its URL and requires updating the private issuer config and reconnecting dev.

The agent edits only CLI TypeScript through bounded overlays. Fixed native verification runs on the trusted Netcup
host with scrubbed environments. There is no general shell, automatic execution/browser loop, generic repo linking,
or multi-tenant runner in this spike. See `spikes/coding/README.md` for running and stopping it.
