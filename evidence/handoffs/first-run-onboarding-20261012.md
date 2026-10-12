# First-run Start, Credits then wallet, Mercator top-ups: 12 Oct evening

Plan: `~/.claude/plans/let-s-grill-me-to-fancy-catmull.md` (Kris approved). The decisions are recorded in ADR 0048
(Start), ADR 0047 (amended: pay mode) and ADR 0049 (prepaid top-ups).

## Why

Kris's first prod session (14:05Z) ran into one dead end after another:
- the free Credits were gone in minutes;
- an approved Mercator job's outcome was lost to a 429;
- a $0 wallet refused to pay, with no visible address to fund;
- nothing onboarded him at all.

## Shipped

All of it is on main, and dev and prod run `d14882b6`.

- **First-run Start** (`/start/<step>`): wallet, funds, how goblin pays, Mercator, more services, what goblin is for.
  - It stands before the chats while open; an untouched Start is derived, so complete accounts never see it.
  - A sign-in Start begins comes back to its step and allows the recommended tools (`POST /api/onboarding/connect`).
  - The funds step shows the wallet's paying address (`WalletStatus.payFrom`) with a QR code and opens the wallet App
    on Add funds.
  - The kickoff makes goblin propose Topics and Personas through `ask_user`. On dev it proposed Lisbon flat hunt,
    paperwork, running, move logistics, Scout and Clerk.
- **In the chat:** a "Fund goblin to get answers" card when nothing can pay; a Finish setting up line after a skip.
  Activity's Get started and Settings' Set up goblin card both lead back to Start. The agent's `<onboarding>` context
  block lists only the gaps.
- **Pay mode** (lane B): Credits first, then the wallet (the default), Credits only, or wallet only; the route is
  goblin's own or Tempo. It is decided per call. Refused payments keep the wallet's code and words.
- **Mercator top-ups** (lane C): `ensureFunded` runs before a job its balance can't cover, $5 a top-up and $20 a day,
  through the `funding` caller.
- **Approved calls** (F5): an approved call now receives URL requests; this was confirmed in prod logs as -32021.
- **Smaller tool listings and lost approvals** (lane D): `mcp_list` is brief, and an approval with Credits out
  answers 200 with the outcome kept in the chat.
- **Free plan:** 200 Credits a day with the $5 wallet rule (dev and prod env). The rule applies only to the free plan.

## Releases

- **dev:** `dc854445` (20261012T164425Z), then `d14882b6` (20261012T171900Z); both authenticated.
- **prod:** promote of `d14882b6` (20261012T172555Z, public, drift verified).
  - The wallet-prod step failed at plan (`RELAY_PRIVATE_KEY`, removed by ADR 0050), so wallet prod stayed on the wallet
    session's newer `61e681b5`, which is the safe outcome.
  - The next promote at main ≥ `d954d25f` aligns both; its wallet plan needs `PIMLICO_API_KEY` in
    `.local/wallet-prod.env`.
- **CI:** the dev environment requires an approval this token can't give, and a CI release run as `ghrunner` left the
  snapshot's `.git/index` group-only. Run the release and promote under the group:
  `sg goblin-release -c "… heavy bun run promote <sha>"`.
- **Flake:** `nodejs_compat … ConfigError` 502s in local-workerd integration tests come and go; rerun the job.

## Open

- An App's first call to a tool that isn't granted fails at once (`apps/web/src/lib/app-bridge.ts` `grantDenied`)
  instead of waiting on the Allow card. The wallet's recommended run covers its Add funds.
- Above the top-up rule there is no approval card; the model is told the shortfall and the rule instead.
- After the wallet's new-recipient approval, the Mercator job is created again by the turn rather than resumed.
- `walletReady` doesn't check the held amount; an empty but connected wallet gets turns that fail as
  `insufficient_funds` (then the fund card shows).
- Kris walks Start on goblin.surf with his own (free) account.
