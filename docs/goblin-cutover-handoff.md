# Goblin cutover handoff

This note is for concurrent implementation work resumed after the goblin rebrand. It records the deployed boundary and
the source names that the pending Purrable Apps plan must use. The pending plan in `~/.claude/plans/concurrent-popping-pike.md`
is intentionally unchanged; reconcile its old Purrable names before applying it.

The supervisor identified Claude session `da5b927e-330a-416e-bf07-6c2e4b7c539f` at `purrable:0.2` (pane `%15`). Its
plan approval remains deferred until quota returns at 06:50 Ljubljana time; the supervisor will manually verify
resumption. The local folder and tmux session names remain in place for that session.

## Source and repository

- The active checkout is still `/home/kristjan/code/purrable` because another live Claude session has it open. Do not
  move or rename that folder until all concurrent sessions are idle.
- The branch is `main`; the completed rebrand/live-acceptance baseline is `5525f22`, and the first handoff commit is
  `2b19aba`. `origin` is `https://github.com/grmkris/goblin.git`.
- The GitHub repository is private at `https://github.com/grmkris/goblin`.
- Active workspace packages and imports use `@goblin/*`; runtime, stage and Worker names use `goblin-*`. Do not add
  new `@purrable/*` imports or Purrable resource names.

| Commit | Change |
| --- | --- |
| `59acf0d` | Product/package/runtime rename and removal of archived scaffolding |
| `7d73211` | OTP-only auth, real-OTP fixtures and private-session smoke |
| `5f49be8` | Shared goblin mark and generated install assets |
| `be72261`, `5525f22` | Live acceptance, retirement and fresh connection boundaries |

| Renamed tracked path | Current path |
| --- | --- |
| `.cursor/rules/purrable.mdc` | `.cursor/rules/goblin.mdc` |
| `tools/oxlint/purrable.ts` | `tools/oxlint/goblin.ts` |
| `tools/test/purrable.test.ts` | `tools/test/goblin.test.ts` |
| `apps/runtime/migrations/0001_email_verification.sql` | `apps/runtime/migrations/0001_rate_limit.sql` |

Workspace directories remain `apps/runtime`, `apps/web`, `packages/contracts`, `packages/ui`, `tools` and `bench`.
Re-read the current root/workspace instructions and inspect status/diffs before editing planned paths. Preserve
`.spec.md.swo` and any concurrent edits; stage only owned paths. Frozen private benchmark bytes remain unchanged.

## Live stages

- Dev is live at `https://dev.goblin.surf`.
- `https://goblin.surf` is reserved for a future production deployment; production was not deployed.
- The Worker alternate host redirects canonically to `https://dev.goblin.surf`.
- Dev has fresh D1 and Durable Object storage. It imported no old users, transcripts, credentials, grants or apps.
- The old `purrable-dev` Worker, `purrable-dev-auth` D1, old PersonalAgent namespace and `dev.purrable.lol` hostname
  were retired after goblin acceptance. Do not target or recreate them.

## Private environment contract

Stage files are mode `600` and must never be printed or committed. Use `.local/dev.env` and the shared Cloudflare
credential file; do not restore the old `PURRABLE_*` variables.

- `GOBLIN_STAGE=dev`, `GOBLIN_APP_URL=https://dev.goblin.surf`, `GOBLIN_DOMAIN=dev.goblin.surf`.
- `GOBLIN_ZONE_ID` is the `goblin.surf` Cloudflare zone; `GOBLIN_MAIL_SENDER=hello@goblin.surf`.
- `GOBLIN_SIGNUP_MODE=closed` and `GOBLIN_SIGNUP_INVITE_CODE` is empty after bootstrap.
- `GOBLIN_OWNER_EMAIL` and `GOBLIN_SMOKE_SESSION_FILE=.local/dev-session.json` are used only by bounded smoke.
- The Worker uses the dedicated, model-limited, spend-capped LiteLLM virtual key in `GOBLIN_MODEL_KEY`; never use a
  LiteLLM master key. Dev Dodo remains `test_mode` with no configured payment keys.
- Dev's known owner has an explicit `app_billing_accounts` dev-only Pro override for 2,000,000 weighted tokens per
  UTC day. This is not a production entitlement.

## Reconcile the pending Apps plan

These are substitutions for the implementation after its approval, not changes to the preserved plan. The new
`packages/app`, `packages/kit`, `LOADER` and `FILES` features are still pending.

| Plan reference | Use on the resumed branch |
| --- | --- |
| `dev.purrable.lol` | `dev.goblin.surf` for every milestone and acceptance run |
| `@purrable/ui`, `@purrable/contracts` | Existing `@goblin/ui`, `@goblin/contracts` |
| New `@purrable/app`, `@purrable/kit` | New `@goblin/app`, `@goblin/kit`; keep directories `packages/app` and `packages/kit` |
| `purrable.apps`, `purrable.app.<slug>` | New `goblin.apps`, `goblin.app.<slug>` extension IDs |
| `api.memo('purrable.release', id)` | New `goblin.release` memo key |
| `_meta['purrable/state']`, `purrable-file://` | New `goblin/state` metadata and `goblin-file://` resource scheme |
| `x-purrable-csrf: 1` | Existing `x-goblin-csrf: 1`, also used by the browser request boundary |
| `PURRABLE_HARNESS_PORT`, `PURRABLE_NATIVE_LIFECYCLE_PHASE` | Existing `GOBLIN_HARNESS_PORT`, `GOBLIN_NATIVE_LIFECYCLE_PHASE` |
| Proposed `PURRABLE_CHROMIUM` | Name the new browser override `GOBLIN_CHROMIUM` |
| Egress exclusion of `*.purrable.lol` | Preserve the self-host exclusion for `goblin.surf` and its subdomains, including dev |
| New `@purrable/app` prebuild in `scripts/stage.ts` | Build `@goblin/app`; retain the current private env loader and stage guards |
| Plan's `docs/archive/` rule | That tree was explicitly removed during rebrand; keep current living docs in sync |

For source and generated SDK examples, update the import allowlist, toolchain docs, bundle labels, smoke markers and
test fixtures together. Existing `PersonalAgent`, `app_*` tables, Pi ownership and owner/grant boundaries remain the
same. Keep the goblin mark and shared Geist/theme styling when adding the app kit.

If a clean deploy worktree is needed, use current `main` and only `apps/web/.alchemy/state/goblin/dev/` for Alchemy
state, plus the current mode-600 stage files and OTP session when smoke needs it. Older linked worktrees and the
`/tmp/purrable-spikes/` evidence were not rebased or rewritten. They are not a source of current dev state or
credentials. Coordinate deployment/state writeback so only one operator updates this dev stack at a time.

M0's MyPlan App check now needs a fresh owner connection and exact grants: the old connection was not imported.
Record it as unverified until that acceptance runs. Dev now contains the verified owner and new smoke history, so
subsequent Apps changes must be additive; do not reset its stores to reproduce the pre-bootstrap empty receipt.

## Auth and UI changes

- Email OTP is the sole login method: six digits, hashed at rest, 600-second expiry, five attempts, one-minute address
  cooldown, and D1-backed rate limits. Password, passkey, reset and verification-link routes are unavailable.
- Auth migration `apps/runtime/migrations/0001_rate_limit.sql` replaced the old verification migration; the passkey
  migration and auth modules were removed.
- Branding is shared from `packages/ui/src/brand.ts` and `packages/ui/src/components/goblin-mark.tsx`; generated icon,
  favicon and splash assets are under `apps/web/public/`.

## Evidence and gates

- `heavy bun run check` passed: formatting, agent/docs checks, graph, all workspace typechecks, lint/Effect/Knip,
  duplication, 425 unit tests, 44 runtime native integration tests, one native benchmark integration and the build.
- Live smoke receipt `.local/smoke-dev-receipt.json` is passed. It covered health, closed-signup refusal, inbound OAuth
  consent, model turn, thread sharing, subagent reporting, memory and temporary MCP client revocation. Suggested
  outbound MyPlan and MyBrowser servers remain disconnected and ungranted; fresh owner connection work is separate.
- Browser receipt `.local/goblin-acceptance/browser.json` is passed: real owner OTP login, closed signup, desktop/mobile
  views, no page errors, no failed requests and no mobile overflow.
- Public receipt `.local/goblin-acceptance/public.json` records removed auth routes as `404`, anonymous protection as
  `401`, closed OTP signup as `403`, health as `200`, and canonical redirect as `301`.
- The pending Apps implementation must preserve these gates, use additive migrations only, and deploy each green
  milestone to `dev.goblin.surf`. Re-run `heavy bun run check` before claiming completion.

The concurrent-handoff gate rerun initially failed at `native.test.ts:240`: the routine-usage fixture did not reach its
expected `failed` state and returned `500`. The unchanged focused test passed on `GOBLIN_HARNESS_PORT=18931`, and
`GOBLIN_HARNESS_PORT=18931 heavy bun run check` then passed fully. No runtime files were changed; the first failure's
cause is not established. Logs are `/tmp/goblin-handoff-check.log`, `/tmp/goblin-handoff-routine-check.log` and
`/tmp/goblin-handoff-check-retry.log`.

The pending plan's SHA-256 at handoff is
`4fbe0a99abb964d385b951a8090366e1c53b2afdb04c00bdc335acfc91526e30`; it was read but not modified.
