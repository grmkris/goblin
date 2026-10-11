# Showcase run: goblin × Sidequest, live on dev (11 Oct 2026, 21:05–22:55 UTC)

Written 2026-10-12 by the goblin lane. goblin dev at e93e77dc (ADR 0042 released); Sidequest dev with rows 6–9 from
the `live-mcp-agent-roles` lane; the Sidequest crew (Docker `sq-bot-*`) as competing workers; gas sponsorship on;
testnet only. Kris approved every write in the browser. The matrix and status log are on myplan Sidequest note 24.

## What was proven live

| Row | What | Result |
| --- | --- | --- |
| 6 | Live tool lists over `subscriptions/listen` | Connect → listen → "tools changed" → re-list in place. Roles allowed → 57→64 tools; Work unticked → 64→57 with `submit_work` kept. |
| 7 | URL requests (`input_required`, url mode) | `create_agent`, two over-limit `pick_quote` (one approved, one rejected), `request_role` declined then allowed, each through goblin's card. |
| 8 | Step-up (403 `insufficient_scope`) | **Not live**: goblin asks for every offered scope, so it never holds a narrow grant. Fixture renders only. Kris to decide how to stage it. |
| 9 | Roles and `request_role` | Live, as above. |
| 10 | Ask first | goblin held `approve_work` with exact arguments until Kris approved. |
| 4/5 | Events as notices | Job lifecycle notices in the chat in real time. |

Jobs: #82 approved and paid; #83 and #84 accepted by silence; the over-limit Pixel hire rejected. Goblin Demo also
worked a job for a second account (another goblin connection, agent 2198) and earned 2.1 mUSD. The crew competed
(Quill vs Grok Bot, Pixel vs Grok Bot). The reject-work/arbiter beat was skipped: #84's delivery met its brief.

## Where the material is (not in git)

- Video kit, the brief for a video agent: `.local/video-kit-20261011/` and `.local/video-kit-20261011.zip` (1.1 GB):
  122 screenshots, 9 page videos, 16 data captures (goblin state and ledger, goblin and Sidequest Workers Logs, merged
  timelines), card fixtures, the run log, `README.md` (beats with times and shots), `findings.md`, `wire.md`.
- Originals: `.local/evidence/joint-run-2026-10-11/` and `.local/evidence/joint-run-video/`.
- Tooling: `.local/joint-run/capture.ts` (state + ledger + both Workers Logs for a window) and
  `.local/joint-run/browser.ts` (recorded Playwright browser over a local HTTP API).

## Findings (shot numbers refer to the kit)

### goblin — bugs (to fix)

1. **A URL request whose tool leaves the list cannot be finished** (row 7). After Kris approved the new agent,
   Sidequest turned the setup connection into the agent's connection, so `create_agent` left the live tool list.
   goblin's Done refused the retry locally ("not found"), the card ended "The call could not be sent again", although
   Sidequest had completed it. Fix: an answer retry the server asked for must be sent even when the held tool is no
   longer listed (grant still checked). Confirmed: `04-a2-done-retry/timeline.txt`, shot 048.
2. **Connections shows a stale tool list after the live list changes**, and **Allow all aborts on the first missing
   tool** (refs a490dfdd, a491004c). Seen twice (65 shown vs 4 live; 64 shown vs 57 live). Fix: refresh the owner's
   tools view when the connection re-lists; let Allow all skip tools that are no longer live. Shots 023, 054.
3. **Background Events polls count as "use" of a connection**, so goblin re-opens a listen stream on every poll and
   lets it idle out 60 s later (Sidequest saw consecutive ~61 s gaps between `subscriptions/listen` requests). This
   keeps the Durable Object awake for no one. Fix: only model or owner activity should open the listen stream.
4. **goblin's 30 s MCP request timeout is shorter than Sidequest's `create_agent`** (it draws an avatar). The first call
   was cancelled (`notifications/cancelled`), goblin reconnected and retried. Fix: a longer timeout for known-slow
   tools, or treat cancellation of an idempotent call as "retry with the same key".
5. **Model 404s are not retried.** Meta Muse answers `model_not_found` in spells (measured 2 of 6 calls at 21:43);
   LiteLLM's retry aliases don't absorb it and goblin surfaces it as a failed turn. Fix: retry `model_not_found` for
   that model group (bounded), or fail over to the chat's second model.
6. **The answer to a URL request is posted as a visible owner message containing the full raw JSON result** (shot 081).
   Fix: send it as a collapsed, owner-only continuation (like an approval's).
7. **No way to publish a public page** — goblin wrote the deliverable but had to ask the owner to host it (shot 106).
   And **no way to read a web page** — it could not review a delivery URL (shot 119). Both are capability gaps for an
   agent that works and hires on marketplaces.

### goblin — UX

- A failed URL card stays in the chat with disabled buttons after the owner moves on (048 onward).
- The status indicator says "Waiting for you" while a turn is running (Stop visible).
- The receipt line names the connection's id ("dev-sidequest-exchange-ad1f8d's site") instead of its label.
- Notices fold into "+10 more from Sidequest · Demo" quickly; the job-delivered notice was hidden when it mattered.

### Sidequest — bugs

1. **First sign-in crashes**: "Cannot destructure property 'onSuccess' of 'd.createWallet' as it is undefined" — 2 of 2
   fresh accounts (shots 004, 095). Reload recovers. (Sidequest lane: Privy wallet-created screen race; fix planned.)
2. **`events/list` answers -32601 on a setup connection** while Events is advertised; goblin's Events section showed an
   error until the agent existed. (Lane: fix planned — return the catalog, clear "no agent yet" on subscribe/poll.)
3. A **"Quote picked … linked to task e6617ea2…" notice arrived after Kris rejected that over-limit hire** — contradicts
   the rejection.
4. **"Connected clients" said "may work and hire" after Work was unticked** (shows scope, not roles).
5. From the lane's log review: legacy `notifications/initialized` answered -32601 (should be 202);
   `resources/templates/list` unimplemented.

### Sidequest — onboarding UX (for the redesign)

- After the crash + reload, the sidebar shows **both "Sign in" and "Sign out"** (005).
- After sign-in the URL changes to /welcome but the page keeps showing Activity (009).
- Welcome step 2 says **"One signature"**; registration took one visible signature here (two expected by the code).
- Signatures show **raw EIP-712 `DelegationManager` typed data** (delegate, delegator, authority 0xfff…, caveats as
  hex) — unreadable to a person (031, 078).
- The backing transaction shows **"To: your own address"** with no SIDE amount or agent named (071).
- After backing, **"In your wallet: 1,000 SIDE" does not update** (072); Privy's success dialog is aria-labelled
  "log in or sign up".
- Consent (agent-first) says **"this tab opens a 127.0.0.1 page"** — wrong for a hosted client like goblin (020, 101).
- Welcome step 2 "Create your agent — done" still says **"Paste the line below into your coding agent to connect it"**
  when the agent is already connected (066).
- Approvals: **Reject and Disconnect act on one click, no confirmation** (084, 121).

### Backing checkpoints (asked by agent-jobs-e1; sent to them)

1. Create agent / Connect a client: **no screen says the agent needs SIDE before it can post** (011, 020, 029, 030).
   Consent with an existing agent even says **"Weekly budget and SIDE backing can be added later"** under "Optional SIDE
   backing" (101).
2. "Back it" **does not state the 10 SIDE minimum to post**; it explains only taking work, slashing and the unstake
   period. It is clear that it's a separate wallet step ("Your wallet pays the gas in MON") (066, 067).
3. First publish unbacked → readable: `{"code":"conflict","reason":"insufficient-backing","retry":"after-operator",
   "message":"The creator bond is 10 SIDE but only 0 SIDE of backing is available behind 0x8fc1…1f30; back it with
   more SIDE, then retry"}` (064, 065).
4. **The user learns at submit time**: requests posted fine unbacked, the crew quoted, only the pick failed ~4 min
   later while quote windows ran on.

Suggested fix: one guided onboarding path — tokens (incl. MON), create agent, **back it (state the 10 SIDE posting
minimum and recommend ~50)**, set a weekly budget — and a warning at request time when posting would fail at pick.

### mysi (mytab, myinbox) — tooling for agents

- **mytab screenshots can't be read or saved by an agent**: the artifact URL needs the mysi bearer; `browser_artifact`
  says "Retained captures are disabled". No video for extension backends. Kris was signed out of mytab during the
  evening. (Reported to the myapps session with a full brief.)
- **myinbox `address_create` for an address outside the grant's reach looped 10 rounds of input_required**, and the
  widen page could not load for a not-yet-existing address. (Diagnosed by myapps; Kris widened reach to all.)

### Model infrastructure

- Meta Muse: 404 spells (above). Alibaba token plan: quota exhausted until Kris raised it mid-run (Qwen, GLM and
  DeepSeek all ride on it). Gemini 3.8 Flash: "provider overloaded" once.

### What worked (for the positive story)

- Row 6 live tool lists: connect → listen → immediate "tools changed" → re-list; roles allowed → tools appear; Work
  unticked → apply/quote/activate disappear while `submit_work` stays.
- Row 7 URL requests: three server approvals (agent registration, two over-limit hires, two role requests) each round
  tripped through goblin's card; the pick retry confirmed in 60 ms after Done.
- Ask first: goblin held `approve_work` with exact arguments until Kris approved.
- Events: job lifecycle notices arrived in the chat in real time.
- Three jobs paid end to end (#82 approved, #83 and #84 accepted by silence), one hire rejected, one role declined.
- Goblin behaved honestly: stopped on missing backing, asked how to host a page, refused to reject unread work.
