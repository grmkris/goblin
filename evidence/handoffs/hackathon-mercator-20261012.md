# Handoff: goblin for the hackathon — first-class Mercator, spending rules, showcase fixes (2026-10-12)

Plan: `~/.claude/plans/let-s-grill-me-to-fancy-catmull.md` (approved by the owner, 12 Oct). ADRs 0043 (outside work
through MCP servers) and 0044 (spending rules for paid tools); ADR 0042 amended (choosing access, step-up keeps the
owner's narrower choice); ADR 0041 amended (folded notices go to Activity).

## What landed (on `main`)

| Area | Commits |
| --- | --- |
| Decisions | `bb5a9c91` ADR 0043 + 0044, glossary |
| Showcase fixes | `551f1250` deadlines, `c355dfbc` answer after the tool left, `373baa34` listen follows use, `aca5d157` Events wake when due, `47e2585d` live tool lists, `c684ad2f` outcome rows, `3cf7d72c` dock, `909a4b2e` labels, `09465715` cards and receipts, `bb2e0f17` notices past the cap |
| First-class Mercator | `f4b6668f` profiles, `3f1b01a5` configured + signed-out offer, `21d4d694` Allow recommended + wallet line, `718184c5` its App in one tap, `39193a35` spending rules, `2a05a956` paid-job card + rule controls, `21343c4b` test fix, `065dac1e` instructions + connect card, `5c7d0806` onboarding, `1704d9e4` Add funds |
| Publishing | `df2ce4d0` Cloudflare first-class on the shelf (Workers scripts scopes added at sign-in; `execute` asks first) |
| Models | `cc0184d0` DeepSeek V4.1 Flash label; LiteLLM alias in the personal repo `7920984`, allowed on `goblin-prod` and `goblin-dev-otp-20261006`; `.local/{dev,prod}.env` default + memory (+ dev smoke) = `deepseek-v4.1-flash`, Muse and Qwen stay pickable |
| Access | `3be96a18` Choose access (row 8) |
| Ops | `e9c82ee5` `destroy:prod` (needs `--confirm-reset` and `GOBLIN_CONFIRM_PROD=1`) |
| Owner's GLM report | the starved-request guard (`MIN_ANSWER_ROOM`), the thinking-only cut-off and overflow wording, GLM's picker note |
| Onboarding copy | each profile's `offer` line |
| Docs | `b703c078` mcp-host skill |

## Facts found on the way

- **cliproxy's Token Plan cooldown is stale.** cliproxy answers `model_cooldown … quota exhausted, resets 11-06` for
  every Token Plan model, but the same subscription answers fine directly and through Railway LiteLLM (qwen3.8-flash,
  glm-5.3, deepseek-v4-pro, deepseek-v4.1-flash all call tools, 12 Oct). goblin's stages use LiteLLM, so they are not
  affected; cliproxy users (Hermes, coding agents) are. Not restarted from here: it carries this session and others.
- **Cloudflare's MCP** (`https://mcp.cloudflare.com/mcp`) publishes only `user:read account:read` as the resource's
  scopes; the authorization server lists the rest. Publishing needs `workers-scripts.write`, hence the profile scopes.
- **Sidequest scopes** (from its lane, dev `c5ef37a6`): a narrower authorize request gets a narrower token
  (`sidequest:read` always kept; the response's `scope` is sorted, compare as a set); a held role the token lacks
  answers 403 `insufficient_scope` with the full scope set; refresh tokens are issued without `offline_access`.
- **Mercator's top-up**: its `fund_wallet` tool hands the owner to `https://mercator.sh/account`; goblin links there
  while `get_connection_status` says funding is blocked. The Agentic Wallet MCP does not exist yet (the Codex session
  produced research only: `/tmp/goblin-mcp-apps-plan-20261012.md`); its profile takes the top-up slot when it does.

- **GLM cut off in Personal (prod, 2026-10-09 and 10-12).** glm-5.3 reasoned through its whole 32,768-token output at
  ~99K context (op `548fb4c3…`); pi-ai's estimate then counted that output into the context (131,410 > 131,072), so
  the next request went out with `max_tokens` 1 (op `7c7cf488…`) and ended `length` with output 1, which Pi does not
  take for an overflow. The Token Plan ignores `thinking_budget` for glm-5.3 and refuses `enable_thinking: false`
  (probed directly and through LiteLLM): its thinking cannot be bounded. DeepSeek V4.1 Flash reasons briefly (1,751 of
  2,256 tokens on the same prompt).

## Deviations from the plan

- The Activity "Get started" offer's Not now is kept in the browser (localStorage), not server-side.
- The Agentic Wallet profile is not added: no endpoint or tool names yet.

## Interface polish review (make-interfaces-feel-better, full)

Scope: the paid-job approval card, the wallet line and Add funds, the first-class server card (Allow recommended,
Open Mercator, spending rule), Activity's Get started row, the empty-chat line, Choose access. React + plain CSS in
`apps/web/src/styles.css` over the local shadcn package.

| Category | Evidence inspected | Result |
| --- | --- | --- |
| Typography | `paid-job.tsx`, `first-class.tsx`, `styles.css` 1145–1260 | tabular-nums on amounts, steps, wallet and rule inputs; Clear |
| Surfaces | same, `connection-forms.tsx`, `connect-offer.tsx` | 1 finding (below); radii and hit areas follow the shared tokens |
| Animations | no new motion | Clear |
| Icons | `CircleAlertIcon`/`WalletIcon` in the wallet line, `KeyRoundIcon` in the menu, `PlugIcon` on the offer | lucide only, one stroke; Clear |
| Performance | no transitions added | Clear |

### Findings

#### Copy that misleads (fixed)
| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| MEDIUM | `apps/web/src/components/conversation.tsx` (empty chat) | "Connect Cloudflare on Connections, so goblin can search the web…" for any profile | the profile's own `offer` | An action's words must say what it does; Cloudflare does not search |
| MEDIUM | `apps/web/src/lib/chat-messages.ts` (length stop) | "Cut off at the output limit. Ask it to continue." when nothing but thinking came out | "It spent its whole output limit thinking and wrote no answer. Send again, or pick another model below." | Failure copy gives direction; continuing met the same wall |

#### Minimum hit area
| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| LOW | `apps/web/src/components/first-class.tsx` (wallet line's Add funds, Open Mercator) | inline `cause-link` in a sentence | kept: inline links in running text, as the rest of the receipts | A pseudo-element hit area would overlap the line's other link |

### Considered but rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| `styles.css` `.run-up-to-amount > input` | 40 px min-height on fine pointers | 32 px matches the spending rule's inputs and the dense card; coarse pointers already get 44 px |
| `connection-forms.tsx` Choose access | Monospace for scope tokens | The brief rejects monospace for labels; tokens wrap with `overflow-wrap: anywhere` |
| `paid-job.tsx` amount | A larger amount or an accent colour | The amount is already the largest type on the card; the brief spends boldness there without colour |

### Verification and verdict

- `heavy bun apps/web/test/ui-holds.ts`: ok (paid-job card light/dark, phone/desktop).
- Web unit suite 543 passed; runtime targeted suites passed; full `heavy bun run check` on `6c249c18`: green (runtime 722, integration 83, permuted 72; the second run caught the
  Persona `connect` hold, fixed in `6c249c18`).
- **Not verified:** Choose access and the Add funds link in a browser; they are checked on dev in the live pass.

Verdict: Approve after the live pass covers the two unverified surfaces.

## Still open

- **Dev** runs `6c249c18` (receipt `541c349d…`, acceptance authenticated; the first smoke hit the Durable Object's
  ~10 min env lag, `smoke_model_not_offered`, and the same release passed after it). `bun run ui:acceptance`: 64
  screenshots, no errors. It showed the dev owner's second, configured Mercator ("Mercator 2") offered on Activity while
  the added one is connected; onboarding now offers a profile only while none of its connections is signed in.
- **Dev live pass** (needs the owner: testnet writes approved in-session, Mercator funded). Mercator configured and
  featured, OAuth, Allow recommended, wallet line, Open Mercator, a paid job via the card (Approve, and up to $5), a
  second job under the rule without asking, past the daily total it asks, Add funds while funding is blocked;
  Cloudflare publish behind Ask first; Choose access on Sidequest (untick work → 403 → step-up → Continue); default
  turns on DeepSeek.
- **Prod reset at release** (owner decided): confirm no live Dodo subscription; blank `GOBLIN_SMOKE_SESSION_FILE` in
  `.local/prod.env`; `GOBLIN_CONFIRM_PROD=1 bun run destroy:prod -- --confirm-reset`; `release prod` of the same sha;
  bootstrap (invite + OTP sign-up, `plan_override='pro'`, connect Mercator with Allow recommended, Telegram, new smoke
  session, `smoke:prod`).
- **cliproxy's stale Token Plan cooldown** (owner's call to restart it).
- **The Agentic Wallet**: session `goblin-wallet-evm-build` landed it on main (`6c249c18..9fa82ec8`, ADR 0045, a
  WALLET profile with per-stage shelf endpoints). The prod sha is the owner's choice: with or without the wallet.
- **myapps-a1**: retest myinbox on prod only if the owner okays it.

## Update, 12 Oct afternoon

**Released.** goblin dev and prod run `e2ad96f0` (dev: authenticated smoke; prod: public smoke and drift verified).
Prod was reset first (`destroy:prod`, owner-approved), then released at `9ca847e2`, then at `e2ad96f0`.

**Owner decisions since the morning.**
- Prod is open to anyone with a free plan (owner, 12 Oct): `GOBLIN_SIGNUP_MODE=open`, `GOBLIN_FREE_DAILY_CREDITS=50`.
  - An account without Pro gets 50 Credits a day and no routines (`c33ee108`).
  - The cached plan used to ignore the feature it was asked for; it now checks it.
  - `release.py` keeps invite-only for a stage's first prod release only (`57cf4149`).
  - The public smoke accepts open sign-up (`e2ad96f0`).
  - Default model: DeepSeek V4.1 Flash.
- The composer sends at most two Apps' shared context, which is the contract's limit (`84d0ddb9`). With three or more
  "Sharing from" chips, Send used to do nothing.

**Dev live pass (owner-approved testnet writes).** Evidence is in
`.local/goblin-acceptance/livepass-20261012/`.
- **Mercator.** All checks pass. The total charged was $0.008, for two jobs.
  - A $0.004 job showed the paid-job card (amount, route, wallet line, Open Mercator) and was approved with
    "and up to $5". The rule became $5 per job and $20 per day.
  - A second job ran under the rule without asking.
  - With a $0.01 daily total, the third job asked first and was refused.
- **Sidequest, run through goblin's client (with the Sidequest lane).**
  - B3, A4, A5 and B4 pass. Findings: `create_task`'s backing refusal took 15.7 s; the bond-horizon error came only
    after backing (fixed in Sidequest `b8bfbec3`, not yet deployed).
  - Row 8 passes. A narrow sign-in held exactly `hire read`. A work tool led to a 403, then the step-up card. The step-up
    scope was exactly `hire read work`, and Continue then got through.
  - B5 was not run: the dev crew is stopped and the owner deferred it.
- **Cloudflare.** The sign-in asks for the Workers scopes. Publishing waits for the owner's own consent on dev's
  "Cloudflare · check" connection.

**Operational notes.**
- The shared checkout holds another session's uncommitted `scripts/release.py` gate (a dev branch and a CI check).
  Running a release from that checkout fails, so releases ran the committed script from a worktree.
- The dev owner's allowance was raised to 1600 Credits a day (dev auth D1).
- cliproxy was restarted (owner OK). Its stale Token Plan cooldown is cleared.

**Owner to do on goblin.surf.** Sign up (open, no code). Then:
- `plan_override='pro'` for the owner;
- connect Mercator (Allow recommended) and Telegram;
- save a smoke session, then run the signed-in `smoke:prod`.

## Inference paid per call from the Goblin Wallet (ADR 0047), 12 Oct afternoon

**Shipped** (main, then dev and prod at `8fd49a6b`):
- G1 `cb34d0d7`: paid routes `paid:tempo` and `paid:goblin`, the `inference` MCP caller and the 402 → pay → retry fetch.
- G2 `84ac4aa3`: "How goblin pays for its model" in Settings, and the pay offer in Get started.
- G3 `a9b4eb99`: goblin's own `POST /v1/chat/completions` behind an mppx `tempo` charge to the treasury.
- G4 `7ded50de` and `b4192bd9`: the free plan's 50 Credits ask for a Goblin Wallet with at least $5, read from the
  wallet's own `stablecoinUsd` total.
- `2a399c3f`: a paid call reports its `Payment-Receipt` to `pay_challenge`, so the wallet settles the operation. A
  spend the wallet holds over a limit says so.

**Releases.** CI's Release dev fails at "Materialize private stage credentials", so releases ran by hand from a
worktree with `GOBLIN_ENV_DIR` set to the shared `.local`.
- dev: receipt `20261012T140139Z`, authenticated.
- prod: `heavy bun run promote <sha>`, receipt `20261012T140827Z`, public acceptance; wallet prod `7b86ac2d` from the
  same sha.
- Prod env (Kris approved directly): `GOBLIN_PAID_INFERENCE=tempo,goblin`, recipient treasury
  `0x6649868b1B87711e405aa6690E3f0245d9510631` and a prod-only `GOBLIN_MPP_SECRET`.

**Proven on mainnet from dev** (Kris approved). Both payments came from kristjan@myinbox.lol's wallet-dev connection
(agent `0xD354…274F`). Each turn answered, and the wallet marked its operation delivered from goblin's receipt report.
- `paid:tempo`: tx `0x67d58f4f4649276e5b88dc0714c7ece6a5745fee700074c1768ea837b94cf211`, 0.020527 USDC.e to Tempo's
  payee.
- `paid:goblin`: tx `0x68b7d933e7536db346e546240361a9b4c2928ed565d44945549fdf32847af06f`, 0.019957 USDC.e to the
  treasury, plus 0.000178 USDC.e network fee. This is the first mainnet proof of the self-paid fee.

**To use it on an account:**
1. Connections → Goblin Wallet → review recommended access → Allow (`pay_challenge`).
2. Settings → "How goblin pays for its model" → a pay-per-call route.

**Open.**
- Per-token billing waits for MPP sessions.
- No paid call has run on prod yet; the recording's clips 2–4 are the first.
