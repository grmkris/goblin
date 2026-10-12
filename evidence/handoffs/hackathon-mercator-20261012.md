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
