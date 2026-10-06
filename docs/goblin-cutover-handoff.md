# Goblin cutover handoff

This note is for concurrent implementation work resumed after the goblin rebrand. It records the deployed boundary and
the source names that the pending Purrable Apps plan must use. The pending plan in `~/.claude/plans/concurrent-popping-pike.md`
is intentionally unchanged; reconcile its old Purrable names before applying it.

## Source and repository

- The active checkout is still `/home/kristjan/code/purrable` because another live Claude session has it open. Do not
  move or rename that folder until all concurrent sessions are idle.
- The branch is `main`, clean at commit `5525f22`; `origin` is `https://github.com/grmkris/goblin.git`.
- The GitHub repository is private at `https://github.com/grmkris/goblin`.
- Active workspace packages and imports use `@goblin/*`; runtime, stage and Worker names use `goblin-*`. Do not add
  new `@purrable/*` imports or Purrable resource names.

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

## Auth and UI changes

- Email OTP is the sole login method: six digits, hashed at rest, 600-second expiry, five attempts, one-minute address
  cooldown, and D1-backed rate limits. Password, passkey, reset and verification-link routes are unavailable.
- Auth migration `apps/runtime/migrations/0001_rate_limit.sql` replaced the old verification migration; the passkey
  migration and auth modules were removed.
- Branding is shared from `packages/ui/src/brand.ts` and `packages/ui/src/components/goblin-mark.tsx`; generated icon,
  favicon and splash assets are under `apps/web/public/`.

## Evidence and gates

- `heavy bun run check` passed: formatting, agent/docs checks, graph, all workspace typechecks, lint/Effect/Knip,
  duplication, unit tests, 44 native integration tests and the production build.
- Live smoke receipt `.local/smoke-dev-receipt.json` is passed. It covered health, closed-signup refusal, inbound OAuth
  consent, model turn, thread sharing, subagent reporting, memory and temporary MCP client revocation. Suggested
  outbound MyPlan and MyBrowser servers remain disconnected and ungranted; fresh owner connection work is separate.
- Browser receipt `.local/goblin-acceptance/browser.json` is passed: real owner OTP login, closed signup, desktop/mobile
  views, no page errors, no failed requests and no mobile overflow.
- Public receipt `.local/goblin-acceptance/public.json` records removed auth routes as `404`, anonymous protection as
  `401`, closed OTP signup as `403`, health as `200`, and canonical redirect as `301`.
- The pending Apps implementation must preserve these gates, use additive migrations only, and deploy each green
  milestone to `dev.goblin.surf`. Re-run `heavy bun run check` before claiming completion.

