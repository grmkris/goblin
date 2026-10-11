# Handoff: connections, Tell me and Hand to (ADR 0041), 2026-10-11

The approved plan (`~/.claude/plans/let-s-grill-me-to-fancy-catmull.md`, phases 0/A–F) is built on `main` up to
907c8468, in 28 commits from 8d2f4721. It is **not released to dev yet**: the release needs a dev reset and the
owner's sign-in right after (below). The done gate, a live two-bot run on Sidequest dev, waits on the Sidequest team.

## What landed

- **Groundwork.** ADR 0041 and glossary (8d2f4721); `serverId` is `connectionId` everywhere (cb35c6af); retired
  columns gone (0a5ed11b). goblin is greenfield until launch: migrations are edited in place.
- **Events.** Both capability spellings, one 15 s timeout, optional `payloadSchema` (e2db7dbc); every live
  subscription maintained, tombstones pruned, cap 64 (fca75fc7); a webhook URL per connection (2277d4a3); an owner
  catalog `GET /api/mcp/:id/events` (d52c0946); a connection's offer of events, `ServerView.events`
  open/dismissed/done (9f82a811).
- **Connections.** Several per server, labels, rename, DCR `client_name` "goblin · <label>" (b1be59d8); labels in
  model and owner text (a049d4cb); the web groups and renames them (febe94f3).
- **Routines and notices.** `RoutineDefinition` is trigger + Topic + Tell me + Hand to (a96255e1); Tell me posts
  notices, the replay guard, the 20/hour cap and digest (24715e6c); the notice part (3d62a68e); Telegram copies as a
  notice outbox (59e1343f); Activity's Notifications section, feed and badge (6dba74f2).
- **Personas.** Hand to @Persona at a pinned revision, run in the routine's own run conversation (5467d371);
  "Persona changed — confirm again" and `POST /api/routines/:id/confirm-again` (7b9a51c1); `routine_propose` by
  names, `mcp_list` shows event streams (09c407ff); approvals and Allow from a Persona's turn (5d796cca) and their
  cards under its newest answer (45aece57).
- **Web.** The routine editor in the new shape with a form from an event's input schema (adc6eeb4, plan commits 22
  and 23 together: they do not compile apart); Events on a connection's card and Set up events in Activity
  (d1efa333); browser fixture and two layout fixes (048548c5).
- **Proof.** Integration in local workerd: Tell me over two connections to one producer (cf784424); a Persona's
  holds resume and a routine hands work to a Persona (9eb39f3d). Docs in step (907c8468).

## Deviations from the plan

- Persona resume reuses the `goblin.persona-turn` task with `resume: { fork, text }` instead of a new task kind: it
  shares every phase, and Stop drops it with the other turns.
- `app_persona_forks` is renamed `app_persona_chats`: it also binds a routine's run conversation to its Persona.
- The events offer keeps only the owner's answers (`app_mcp_event_offers`: dismissed, done); open is derived from
  the live connection offering Events. `ServerView.events` replaces `eventsOffered`.
- `ui:acceptance` was not changed: it already opens Activity and Connections, which now carry Notifications and Events.

## Evidence

- `heavy bun run check` passed locally on 907c8468 (format, agents, graph, typecheck, lint gate, dupes, unit,
  integration, permuted integration, build).
- Browser fixture: `heavy bun apps/web/test/ui-events.ts` (desktop and phone, light and dark), screenshots under
  `.local/goblin-acceptance/events-*`.
- CI: 048548c5 failed once on a 60 s timeout in the owner stack's queue case, which these commits do not touch;
  907c8468's run was in progress when this was written.
- Not yet: deployed dev, `ui:acceptance` on dev, the two-bot run.

## Release (plan step 29) — needs the owner

Storage changed shape inside existing migrations, so dev must be reset, not migrated:

1. Green CI on the release SHA; tell peer sessions that dev is being reset.
2. `bun run destroy:dev -- --confirm-reset` (erases every dev account, conversation and MCP credential), then
   `heavy bun run release dev <full-sha>`.
3. Kris signs in by OTP, gets the dev Pro override again, and saves the session as `.local/dev-session.json`
   (mode 600) for smoke and `ui:acceptance`.
4. Smoke, drift, `bun run ui:acceptance`.
5. Live checks against Sidequest dev as it is: two connections, the Events section, a notice.

## Done gate (plan step 31)

The two-bot run on Sidequest dev: connect Hirer and Worker, skills on; routines worker requests → @Worker, worker
inbox → Tell me + @Worker, hirer inbox → Tell me + @Hirer; a zero-bond request; @Worker quotes through an ask-first
approval; "You got picked" arrives as a notice. Testnet only, Kris's go for every write.

The Sidequest prompt is updated for this scope:
`evidence/handoffs/sidequest-skills-events-prompt-20261010.md` (S11 subscriptions by principal and URL, S12 client
name and agent pick at consent, S13 `title`/`summary`/`url` on events). It has not been sent yet.

## Gotchas

- An MCP Events occurrence's `webhook-id` must equal its `eventId`; goblin refuses anything else as InvalidInput.
- The events fixture keys subscriptions by name and callback URL (`sub_<name>`, `sub_<name>~2`…).
- `RoutineView.topic` and `outsideSetup` are required now; `RoutineView.persona` is present only for a Persona hand-over.
