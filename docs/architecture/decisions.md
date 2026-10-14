# Typed decision proposals

## Typed decision proposals

[ADR 0031](../adr/0031-typed-decisions-through-workers-ai.md). The `Decisions` service (`decisions/`, built by
`layers/decisions.ts` after the apps layer and before the workspace feed) judges the owner's chats and keeps the
proposals the owner confirms or dismisses. Its rules, question builders and strict answer and usage decoding are pure
code exported as `@goblin/runtime/decisions`, which the benchmark imports; fixture labels and provider experiments
stay in `bench/`. The critic (`decisions/critic.ts`) applies state-only rules first and asks Clef
(`decisions/client.ts`, the Worker's `AI` binding, five seconds at most) only for undecided ordinary evidence. A report
highlight is offered at 0.5107, a thread draft at 0.7503 and earlier work at 0.594, the frozen v4 thresholds; `none`
and `uncertain` are valid outcomes. The held-out evaluation supports owner review, not automatic actions.

`pi/subagent-relay.ts` hands a Delegate's final report to the service after its passive write, outside Pi commits,
keyed by its relay; the `goblin.decisions` extension (`pi/decisions.ts`, in the owner's chats only: helpers and
routine runs never install it) hands it each answered exchange after yield. A judgment checks resident authority and
the daily budget before any call, runs once at a time per proposal (`SingleFlight`), is fenced on the chat's current Pi
session and epoch and a digest of the exchange, and checks them again before it keeps a proposal; a failure or an
unavailable Clef proposes nothing and never fails the owner's turn. Only the dev stage binds `AI`; everywhere else
(prod, the local stack, the native test stacks) the hooks do nothing at all. Each Clef call counts its tokens toward
the daily usage and is one `model.aux` event of purpose `decision`; proposing, confirming and dismissing are the
flows `decision_propose`, `decision_confirm` and `decision_dismiss`.

The third judgment, cross-Topic context relevance (`decisions/context.ts`), follows the same exchange: after a bounded
catch-up, a search of the transcript index for the owner's newest message (ADR 0035's default Topics, never the asking
chat or a Persona fork) gives the top three sources automatic retrieval did not already give that message. The rules
decide what they can (a source sharing no significant word with the message is not relevant), Clef judges the rest,
and the sources at or above the threshold become one `context` proposal. Once the owner uses it, `goblin.decisions`'
`beforeRequest` hook adds the chat's newest such proposal confirmed in the last day to each request as a
`<chosen-context>` part of goblin's context block (quoted history, for that request only), and records an `auto`
source use (`decision:<proposal>:<entry>`) for each later owner message it serves, so that answer's source strip
names it.

Additive tables `app_decision_proposals` and `app_decision_labels` (migration `20261026000600_decisions`) keep the
proposals and the owner's first label. Every proposal made, labelled or made stale is a `decisions.changed` change, and
the workspace feed carries the newest open and confirmed ones in its snapshot (`proposals`) and each as a
`{ type: 'proposal', proposal }` change. `POST /api/decisions/:id` (the owner API's `decisions` group) takes
`{ label: 'confirm' | 'dismiss' }`; the same label again answers the same proposal, the other one is 409, and
confirming one whose chat moved on makes it stale (409). Confirming keeps a highlight or offers an empty thread draft;
Pi history and send targets stay as they were.

The web keeps the proposals as the workspace's `proposals` slice, and `decisions/hooks.ts` turns each open one into its
chat's "Only visible to you" row (`decisions/rows.ts`): a report highlight quotes the report with Useful, "This could
be a thread" quotes the owner's message with New thread, and "Earlier work may help here" quotes the first source with
Use, each with Dismiss; of a chat's thread and context suggestions only the newest of each shows. A choice posts the
label (`labelDecisionMutation`) and the row goes at once; a proposal gone, settled the other way or stale (404, 409)
stays gone, and any other refusal brings the row back. A confirmed thread suggestion then opens an empty new-thread
draft in that chat's channel (`Navigation.newThreadWith`); nothing is sent or moved. Unit tests cover the runtime
(`test/decisions*.test.ts`, `test/decision-*.test.ts`) and the web (`apps/web/test/decisions.test.ts`); the native
`decisions` probe and the owner's decisions case run with the probe's own Clef, never a paid call.
