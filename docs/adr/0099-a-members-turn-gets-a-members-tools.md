# ADR 0099: A member's turn gets a member's tools

Status: Accepted 2026-10-22; built. It amends ADR 0098, whose admin rule held on the web and on `/mcp` but not yet for
what the agent does on a member's turn.

## Context

ADR 0098 makes what the agent works with an admin's to change: Personas, a Topic's description, guidance and setup,
and routine writes. Owner admission enforces it for every request, from a session or from an OAuth client acting for a
member. The agent's own tools do not go through owner admission. `topic_setup`, `topic_create` with a setup,
`persona_create` and `persona_update` (`pi/organize.ts`) check only resident authority. `routine_propose` and
`routine_pause` (`pi/routines.ts`), `source_route` (`pi/sources.ts`), and `app_build` and `app_rollback`
(`pi/apps.ts`) check nothing about who asked. A plain member who writes in a Topic or in main, or whose client calls
`ask_agent` (`goblin:agent`, on by default), can therefore have the agent make or rewrite a Persona or a setup. The
change is recorded with `actor: 'agent'`, which gets around the rule everywhere else.

What limits it today:

- Every such change leaves a receipt in Activity, and Undo of one that took an admin takes an admin (ADR 0098).
- A drafted routine runs only once an admin confirms it, and a proposed Source likewise.
- Messages from people other than the owner arrive marked as theirs (ADR 0094), so the agent knows who asked. That
  is an instruction to the model, though, not a check.
- When this was written, no workspace on prod had a plain member: the deployment owner's subscription workspace takes
  none (ADR 0095), and the people invited elsewhere are admins.

## Decision

The asker's role travels with the turn. When a member's message is accepted, its submission's receipt in
`app_chat_operations` records the member's role, through a forward agent-storage migration. A turn from a Source, a
routine or the system counts as an admin's. The tools above refuse with `Forbidden` (`role`), in words the model can
relay, when the run they serve began from a member's input. `source_propose` stays allowed, because confirming a Source
takes an admin.

Building it first needs a spike: a tool call knows its `callId` and conversation (`operationOf` in `pi/organize.ts`),
not the submission whose run it serves. The spike checks whether Pi's run for the call can be traced back to its input
(`telemetry/pi.ts` `#operationOf`). If it cannot, the fallback is the newest owner-origin receipt of the chat.

## Consequences

- Until this is built, invite admins only: inviting a plain member is the one action that opens the gap. If one is
  invited anyway, the workspace's admins treat what the agent does on that member's turn as a suggestion they can Undo,
  still bounded by resident authority. A hard guard, the invitation refusing `member` until this is accepted, is the
  owner's call.
- The roles test (`test/http/api/roles.test.ts`) covers only endpoints. Building this adds a matching test for the agent
  tools.

## Built

- Every admission records the role of the member whose request it came in, in `ChatOperations.record`
  (`chats/operations.ts`, through `requestRole` in `keys/policy.ts`) rather than at each caller: the `role` column of
  `app_chat_operations`, added by the forward migration `20261022160000_asker_role`. A Source's, a routine's, a server
  key's and the system's work records none, and a member's replay of an operation id marks it theirs.
- A tool finds who asked through its own call (`pi/asker.ts`): Pi's `pi.live` document gives the run's input
  submissions, each one's request id its operation (a Persona's turn, the operation that tagged it), and a receipt among
  them marked `member` makes it a member's turn. That holds for the run's first input and for one steered in later, so
  a run that batched an owner's and a member's input is a member's. No live run, or no marked receipt, refuses nothing.
- `requireAdminTurn` refuses with `Forbidden` (`role`) and `adminOnly` gives the model the words. `test/asker.test.ts`
  pins the tools, and the workerd members case refuses a member's `persona_create`, `app_build` and `app_rollback` and
  makes the owner's Persona.
- Not covered: a member's reply to a Persona's hold (`POST /api/personas/reply`) admits no receipt, so the resumed fork,
  which keeps `app_build` and `app_rollback`, does not see it as a member's turn.
