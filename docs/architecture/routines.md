# Routines and notices

## Routine definitions

`routines/store.ts` stores bounded drafts and immutable operation receipts in application SQLite. A model can propose a
typed definition (`routine_propose`, which ends its turn), list (`routine_list`) or pause (`routine_pause`), one typed
tool each (ADR 0027); only an authenticated owner may confirm the exact revision. The model names a Persona and,
optionally, another Topic by name; `proposeAsked` (`routines/program.ts`) resolves them and pins the Persona's revision
now (`topicNamed`, `personaNamed`). Routine writes require an exact configured Origin and `x-goblin-csrf: 1`. Edits
clear confirmation and stale revisions return 409. A definition (ADR 0041) is a trigger, a timezone, **Tell me**
(`tellMe: { on, copy }`, a copy through Notify me via only with Tell me, ADR 0070) and **Hand to** (`handTo`: `none`; `goblin` with its
instruction, allowed tools and budget; or `persona` with those and the Persona's id and the revision it pins); one that
hands nothing over must tell the owner. Only a hand-over makes runs (`handOverOf`, `runHandOver`). Work shows the
instruction, exact tool pairs, timezone, budgets and whether notices are copied before confirmation. Its editor
(`components/routine-editor.tsx`, `routine-when.tsx`, `routine-hand.tsx`) asks what, where (the Topic), when, Tell me
(and "Also send to <label>", the sink's connection, offered only while Notify me via is set) and Hand to (nobody, Goblin or a Persona, with the instruction, tools and limits only for a hand-over);
an event trigger picks a connection that sends events, one of its streams (by title) from `GET /api/mcp/:id/events`, and
its filters through a form generated from the stream's input schema (`lib/schema-form.ts`, `components/schema-form.tsx`:
text, a choice, a number, yes or no, a list of texts, required first; a nullable one optional), with raw JSON for
anything a flat form cannot hold; a routine's card says which events it takes in words ("Every one", or each filter's
title and value). A routine lives in a Topic, and its runs are bounded by that Topic's setup as well as its allowed
tools (ADR 0040): each `RoutineView` carries `topic` and `outsideSetup`, the allowed tools the setup does not hold now,
read live so a proposal or a routine's page can flag them; a run that calls one gets the words-only `not-in-topic`
refusal (code `not_in_topic` in its ledger), and a setup edit answers the routines it leaves short.

Confirmed reminders and cron schedules use native dated Agent callbacks carrying routine ID, revision and firing
instant. A short application transaction claims each firing and advances its watermark before rearming; one newest
catch-up replaces missed slots, with a 24-hour window and one encrypted pending trigger while busy. Reconciliation
repairs missing schedules and removes only routine-owned wakes. The earliest-wake check considers future jobs only:
Agents includes the currently firing row in `listSchedules`, and counting it would suppress the next report/recovery
sweep. UTC reminders require an explicit offset. The
numeric cron parser enforces 15-minute spacing, skips spring DST gaps and chooses the earlier autumn repeated instant.

A hand-over to a Persona pins its revision: propose, edit and confirm refuse a Persona that is gone or archived
(`persona_archived`) or a pin that is no longer its current revision (`persona_changed`, 409), so the owner confirms
the Persona as it is. A firing whose Persona was archived or changed since is recorded skipped and pauses the routine
with that reason as its health (`routines/persona.ts` `personaHold`, `RoutineStore.halt`) until the owner confirms it
again. `RoutineView.persona` reads the Persona live beside the pin (`{ id, name, pinned, current, archived }`), so
Work says "changed since you confirmed" as soon as it is edited, and **Confirm again**
(`POST /api/routines/:id/confirm-again`) pins the Persona's revision now as a new routine revision and confirms it in
one transaction. The web reads the routines again whenever the feed shows a Persona changed. The run works in the routine's own run conversation, not a fork of the Topic, so it replays no Topic history and
is charged once: it is configured with the Persona's text in its context tail (`personaText(…, 'routine')`), its model
when offered, and the Persona turn's members without `ask_user`; `registerRoutine` binds the run's chat to the Persona
in `app_persona_chats` first, so its scope is its allowed tools within its Topic's setup joined with the Persona's at
the pinned revision. A completed run's answer is written as the Persona's own `app.persona` entry with the routine's
link (`routine: { id, run }`) under the report's request id; any other ending reports as the routine. The routines'
sweep writes the report: a run that settles wakes it a second later (`settleRoutine`, as a stop does), so an answer
never waits for the next minute's sweep.

Pi background Anchor/Reporter tasks create and recover an empty task-owned run conversation, registered as a thread
without copied capability rows or an ordinary main-start note. The confirmed MCP ceiling narrows `Setups.scope`.
A dedicated per-run model provider checks resident authority, deadlines, committed usage and the day's token cap before
every model dispatch, including compaction. MCP checks repeat at the HTTP dispatch seam after token refresh, with
local correlation headers removed before egress. Main Stop leaves background runs alone; run Stop and archive fence
and abort owned conversations. Questions use sealed shared interaction receipts and authenticated same-session answers.

Committed `pi.usage` counters, including compaction, project into app-only cumulative watermarks and UTC-day receipts:
tokens for the routine's own caps and for the owner's daily usage. Replay does not charge twice; a model response
already in flight may overshoot a cap. Settlement freezes a bounded summary (1600 characters, terminal and bidi controls
stripped, links and credential-shaped text kept as written, ADR 0104) and one `app.routine` parent write with a
stable request ID. A routine belongs to a Topic (`app_routines.topic_id`, migration `20261026000500_routine_topics`, ADR
0032): the Topic of the chat whose `routine_propose` drafted it, or the one the owner names when they propose or edit it
(`RoutineProposal.topic`, `RoutineEdit.topic`; it must exist and be open). Its run conversation sits under that Topic's
Conversation and its report is written there; while the Topic is archived (archive leaves schedules running in v1), runs
and reports go to Personal instead. A copy of a routine's notice through Notify me via is separate authorized plumbing
(see Notices).
Pi acceptance does not establish external delivery.

Event confirmation grants the exact connected server/name/canonical-arguments selector after authenticated review;
its arguments must satisfy the producer descriptor schema. `routines/events.ts` binds `routine:<id>` and the current
revision to ADR 0011's static dispatcher. Shared leases survive until their last consumer retires. Each admitted
occurrence claims a losslessly escaped event ID, seals the event's name, time and data, and labels them as untrusted
data in the fresh run input. The data is the producer's JSON as sent, with no link or credential rewriting; data over
16 KiB is left out whole with a note to read it through the server's tools, never cut (`routines/event-data.ts`, ADR
0104). Replays remain no-ops across revised consumers, even after ingress receipts expire. At most
one event run per minute is admitted across the agent; busy or spacing conflicts replace one sealed pending firing,
whose durable handoff and consumer acknowledgment commit together. Gap controls show recovery health and use the
originating authoritative poll; verification and termination create no model turn. Termination pauses the routine
and requires owner reconfirmation. Pause/edit/archive retire the consumer; pause advances an Event revision so a
retired receipt cannot become live again. Local signed-fixture proof is separate from real producer acceptance. See
[ADR 0012](../adr/0012-routines.md).

## Notices

**Tell me** (ADR 0041) makes a routine's posts notifications. An event's **notice** comes first: `routines/notices.ts`
derives its text from the producer's convention (`data.title` or `data.summary`, with `data.url`; else "<event> from
<label>", `notices/text.ts`), bounded and stripped of controls; its link is kept whole, query and all, when it is an
http(s) address of at most 2048 characters, and left out otherwise (ADR 0104). It is posted as
a passive `app.notice` entry in the routine's home chat (`Conversations.routineHome`: its Topic's Conversation, or
Personal's while that Topic is archived) and attributed to the connection by its label. The model reads it framed as
untrusted data from that connection; memory and retrieval leave it out. A schedule that hands nothing over posts a
reminder (the routine's title) at its slot and advances, with no run; a hand-over's answer, when the owner asked to be
told, is a notification pointing at its report (`notice-report:<run>`), except for a run the owner started. A routine
that hands nothing over cannot be run by hand (`nothing_to_run`).

`app_notices` (`notices/store.ts`) keeps every notification: its entry's request id and chat, the label and text, the
owner's read mark and the outbox state of its copy through Notify me via. A notice is kept once by its id (`notice:<routine>:<eventId>`,
`notice:<routine>:<slot>`), so a replayed delivery posts nothing again; a notice claimed but not written (a write cut
short) is written by the routines' sweep. An event's notice is counted into its routine's hour (`app_notice_windows`):
twenty are posted, the rest kept for Activity only (as written, with no chat entry and no copy) and counted
into one digest line ("+N more from <label> in Activity") the next hour's first notice, or the sweep, writes. Activity
lists ten read notifications under the unread ones, and Show older adds ten more at a time. Reminders, answers and digests are not counted, nor is the skill learner's notice of a draft it wrote (`notice:skill-draft:<hash>`, see Skills). Notifications older than thirty days are pruned. A notice
of a routine with `tellMe.copy`, while Notify me via is set, carries its words frozen when it is claimed
(ADR 0070, `notices/copies.ts`): each due copy is sent once per attempt, with a stable operation id
(`notice-<digest>`), through the sink as it was at its first attempt (a fresh revision per save and a digest of
all settings), the template filled with the words as written (`fillTemplate`, no escaping), as goblin's own call
under the owner's grant of the tool (`caller: 'model'`). Resident authority and the sink are checked again right
before the call leaves. Losing either, a changed or cleared sink, an ask-first tool or an explicit rejection suppresses
it. Owner-reviewed result predicates distinguish accepted, retryable, rejected and unknown (ADR 0071): unknown
outcomes are terminal and never retried automatically. Explicit retries and transport failures retain the stable
operation id, use bounded backoff and fail after five attempts or fifteen minutes; the remote receipt stays separate
from acceptance. Echo suppression requires the same connection and exact configured event selector. Unrelated
services multiplexed on a connection still receive copies. Runs no longer carry a notification of their own. An
occurrence more than five minutes older than the routine's confirmation, or a day old, is acknowledged and dropped,
so a producer that replays its backlog on a fresh subscription neither notifies nor runs. `app.notice`, `app.routine`
and `app.persona` entries count as replies, so a routine's posts leave its chat unread.

Activity lists the notifications from the workspace feed: its snapshot carries the newest hundred written in the last
thirty days (`Notices.views`), and every write or read publishes `notices.changed`, which the feed sends on as a
`notification` change. A notification is unread while the owner has neither read it in Activity
(`POST /api/notices/read`, `notices/api.ts`, at most two hundred ids) nor read its chat past it: opening the Topic reads
its notices too. Activity's count adds the unread notifications to what needs the owner.
