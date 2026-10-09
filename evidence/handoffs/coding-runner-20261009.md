# Portable coding runner handoff — 2026-10-09

Lane R delivered the provider-neutral coding runner on `main` through sequential commits `3e67536`, `34264ab`,
`9da1414`, `e3e57de`, `279d7ac` and `a359276`. The implementation stays within the coding spike paths and keeps the
agent surface to the seven existing coding tools.

## Snapshot and image

The refreshed fixture base is `23eec4e8ee5d92d54d583bf6846d0b117076b1e2`. Native, Docker and Cloudflare use this base for
acceptance. Docker and Cloudflare use the immutable image manifest
`sha256:eef4a6202fd4c115b026c0b9985cc8edeb900faac0c14cc647b5fc8751d5b9ef`. The image receipt and comparison receipt
are private mode-600 files below `.local/coding-cf-spike`.

The refreshed three-backend comparison passed an invalid edit with two diagnostics, a corrected Hello fixture and two
warm checks with zero diagnostics and matching normalized results. Native, Docker and Cloudflare fixed execution each
returned `Hello, world!\n`, empty stderr and exit 0. The prior parity retry was caused by a stale provider session; the
complete rerun used a base-derived session and passed.

## Local and provider evidence

The 20-cold/20-warm verify benchmark used the earlier fixture base `322e22853e4c2b1350d9511e1f489b21b474277e`
and image digest `sha256:2e0c01dfc2f826e38f84f129de7bcdd72f7f6c724b80899f0ec1080683c775a2` (image
size 2,997,303,383 bytes). Cold/warm P50/P95 milliseconds were native 6,035/8,312 and 2,971/3,231; Docker
13,397/13,865 and 9,505/10,002; Cloudflare 11,682/12,269 and 5,134/5,453. These numbers are from different
CPU allocations under shared host load and are not a same-capacity provider comparison. The refreshed base/image was
parity-tested but not rebenchmarked.

The Docker isolation receipt proves no DNS or TCP egress, UID 1000, one CPU, 3 GiB, 256 pids, read-only root, dropped
capabilities, no-new-privileges, no runner secret in the container environment and disposable execution cleanup. Native
verification uses the trusted host compiler wrappers; native fixed execution uses disposable Docker. Cloudflare uses the
dev Worker with `enableInternet=false`. These are operator and provider checks, separate from CI and browser evidence.

A dev-only named Tunnel and three proxied CNAMEs were declared in `spikes/coding-cf/scripts/tunnel.ts`. Deployment returned
Cloudflare authentication error 10000 because the available token lacks Tunnel edit scope. The prescribed fallback uses
three quick tunnels, each retained in its own tmux session:

- native: `https://shapes-encounter-instrumental-associated.trycloudflare.com`
- Cloudflare: `https://assessed-chairs-characteristics-photographer.trycloudflare.com`
- Docker: `https://yamaha-databases-pole-soonest.trycloudflare.com`

Each quick origin returned `/health` 200 for its matching backend. The unavailable stable hostnames are not production
proof.

## Dev and browser acceptance

Three dev connections were created from the quick origins with the new two-origin OAuth registration. Each connection has
exactly `coding_open`, `coding_read`, `coding_search`, `coding_edit`, `coding_ready`, `coding_submit` and `coding_close`.
Each dedicated chat has other connections, skills and subagents disabled. The chat IDs are native `4584`, Cloudflare
`4589` and Docker `4594`. The two previous dev connections were removed,
and the approved old server and tunnel sessions were stopped; the old `goblin-coding-cf-local` container was removed when
present.

All three dedicated chats reached a green `coding_ready` checkpoint. The Docker chat published draft PR
https://github.com/grmkris/goblin/pull/3. Its body was read back and verified to contain the checked revision
`749f8a980b973964d7830d7245b3490a33cb693fbe68031ef138c4c7e50a015`, base `23eec4e8ee5d92d54d583bf6846d0b117076b1e2`, backend
`docker`, and the image digest above; its head commit matches the persisted publication receipt. The PR remains open for
the conductor to close. This is deployed dev API/chat evidence, separate from local checks, CI and owner-browser proof.

## Production connect handoff

`READY-PROD-CONNECT` is recorded in the lane status file with the three active quick origins and private approval-code
file paths. The codes were minted by POSTing to each running service's operator endpoint, which serialized the OAuth state;
only SHA-256 hashes are persisted in each `oauth.json`. The plaintext files are mode 600 under `.local/coding-runner` and
are never printed in logs or chat. They expire after 30 minutes and are single-use. The conductor completes owner-browser
production Connect. No production Goblin API was called by this lane.

## CI and final gate

The spike TypeScript, scoped lint/format, Effect diagnostics where configured and 21 focused OAuth/runner tests passed.
At handoff, PR #3's `check` run was in progress; no green PR CI result was claimed. The final required root command is
recorded in the lane status file after completion. The local root gate does not replace CI, provider, deployed or
owner-browser evidence above.
