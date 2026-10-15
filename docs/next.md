# Next: seams, not built

Where planned features attach, plus the remaining cleanup. Each new feature needs its own decision when it is built.

## Routines acceptance

Confirmed reminders, cron and MCP Events now run in fresh Pi conversations, report passively to main and obey
resident authority, current grants and confirmed scope. Settings provides exact revision review, caps and run
history. [ADR 0012](adr/0012-routines.md) records native fixtures and the remaining deployed acceptance. Real
producer Events, Railway provider accounting and external message completion need separate receipts; local fixtures do
not establish them.

## Connections, Tell me and Hand to acceptance

[ADR 0041](adr/0041-connections-tell-me-hand-to.md) is built and proven in local workerd: two connections to one
producer with their own webhooks, notices and notifications, the replay guard, a routine handed to a Persona through
an approval, and a Persona's holds resumed by the owner. Its done gate is a live two-bot run on Sidequest dev (a hirer
and a worker connection, skills on, events as notices, hand-overs to @Hirer and @Worker, one ask-first approval),
which waits on Sidequest's side of the Events and Skills alignment and on the owner's go for each testnet write.

## Write approvals acceptance

Per-call **Ask first** is implemented for owner-marked MCP tools ([ADR 0028](adr/0028-mcp-call-approvals.md)).
Local native tests cover exact arguments, approval/refusal, owner isolation, grant replacement, scope revocation,
routine and subagent calls, App refusal, and recovery without replay. Real Sidequest hiring and provider-side
operation reconciliation require fresh owner connections and separate deployed acceptance.

## Smaller items

- A production stage is live at `https://goblin.surf`: its own D1, credential key, files bucket and capped model key; nothing is shared with dev. The first public release is invite-only and owner OTP/bootstrap remains an operator step.
- Dev is live at `https://dev.goblin.surf`: its fresh auth D1 and PersonalAgent namespace were verified empty before
  bootstrap, the owner signed in with delivered OTP from `hello@goblin.surf` (SPF, DKIM and DMARC passed), and signup
  is closed after bootstrap. The
  dedicated provider key separately caps aggregate spending at $10 per 30 days and restricts offered models. Live
  acceptance passed health, closed-signup refusal, OTP browser login, desktop/mobile layout, OAuth/MCP consent, model
  turns, thread sharing, subagents, memory and client revocation. Reopening signup needs a global account-admission
  policy and provider capacity review.
  Acceptance was recorded on 2026-10-06; the previous dev resources were retired afterwards. Suggested outbound MCP
  connections remain disconnected and ungranted, so live acceptance proves inbound MCP and models; outbound calls
  await fresh owner connections and grants.

## Sources and notification live acceptance

The legacy Telegram transport is removed (ADR 0069); Mygram uses the same owner-confirmed Source setup as any other
server. Code/local fixture completion is separate from live acceptance. After resetting disposable dev, restore the
model endpoint, reconnect MySI, confirm the Source and configure Notify me via. The owner session in
[Development](development.md#deferred-mysi-and-mygram-live-acceptance) covers Telegram DM, group and photo replies,
non-owner handling, replay, and exact echo suppression on the shared connection. Keep this gate open until those
external receipts exist; preserve the reset/setup checklist rather than dev conversations or files.
