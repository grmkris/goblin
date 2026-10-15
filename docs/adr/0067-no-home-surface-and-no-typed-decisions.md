# 0067: No Home surface and no typed decisions

Accepted 2026-10-15 with the owner. Supersedes ADR 0025 (Home surface) and ADR 0031 (typed decisions through Workers
AI). Amends ADR 0002 (its scoped Workers AI exception), ADRs 0020, 0029 and 0033 (where they name Home), ADR 0027
(the one retool of stored tool filters), ADR 0030 (receipts without a kind), ADR 0034 (what the start did with a
running-turn swap), ADR 0035 (a confirmed context proposal as a source use), ADR 0040 (where it names Home, and the one
delete of the per-conversation switches) and ADR 0064 (the `decisions` feature of `/health`). Part of the cleanup that
makes goblin an open-source, MCP-first client anyone can deploy (ADRs 0056 to 0066).

## Context

Two features from before the cleanup kept a runtime with no reason left for it. Home (ADR 0025) lost its web
presentation on 2026-10-08; its layout service, the `home_read` and `home_edit` tools and the layout in the workspace
feed stayed for "a later iteration" whose place the pinned sidebar, the shelf and App pages (ADRs 0053, 0061) have
since taken. Typed decisions (ADR 0031) judged Delegate reports and the owner's exchanges with Cloudflare Clef through
the Workers AI `AI` binding, bound on dev only: prod never judged anything, the v4 benchmark did not establish
readiness for any automatic judgment, and the binding was the one exception to the model endpoint a deployment
configures (ADR 0059).

The start also carried programs that existed only for data written before a change: a retool that applied every
stored Pi tool filter again once (`subagent` became the `subagent_*` tools), a one-time delete of the owner's
per-conversation switches (ADR 0040), the refusal of every running-turn swap that never settled (ADR 0034's swap was
built and measured, never shipped), and a `legacy` kind for receipts admitted before receipts had kinds (ADR 0030).
goblin is greenfield until launch: no backwards compatibility and no legacy decoders.

## Decision

- **No Home.** The Home service and store, its tools, contracts and change topic, the layout in the workspace feed
  and the tile an App's deletion dropped are gone. An App lives in its chat and on its page (page > inline), and the
  owner pins App views and servers in the sidebar (ADR 0053). The rail's Home, the channel the tab showed last, stays.
- **No typed decisions.** The `Decisions` service, Clef and its client, the `goblin.decisions` extension, the owner
  API's `decisions` group, decision proposals in the workspace feed and the "Only visible to you" rows they filled,
  the `decision_*` flows, the `decision` purpose of a model call outside a turn, the `AI` binding and the `decisions`
  feature of `/health` are gone. goblin calls no model but the endpoint the deployment or the owner configures, and
  nothing judges the owner's chats in the background.
- **Only the settled-turn move.** Move to thread is ADR 0034's settled-turn move and nothing else: every row of
  `app_chat_moves` is of `settled` mode, and the start refuses no swaps, since nothing ever writes one.
- **No one-time data programs at the start.** The start neither applies the stored filters again once nor deletes the
  old switches once (`RetoolLive`, its markers and its `job` line). A Pi filter is written with the current tool names
  when its chat is made or configured and when its Topic's subagents change. Every receipt has its operation's kind
  and state; a row without them is not a receipt, and a turn's source falls back to its operation id only when no chat
  admitted it.
- **The tables stay until the squash.** `app_home`, `app_home_operations`, `app_decision_proposals`,
  `app_decision_labels`, and the `swap` and `swapped` values `app_chat_moves` allows, stay in the migrations until they
  are squashed; nothing reads or writes them.

## Consequences

- A request has no Home tools and no chosen-context block; a Delegate's report and an answered exchange start no
  background judgment.
- The workspace feed's snapshot has no `home` or `proposals`, and its changes no `home` or `proposal`; the owner API
  has no `decisions` group; `/health`'s `features` are `largeFiles`, `agentApps` and `flows`.
- A deployment binds no Workers AI.
- A dev agent that still holds rows of these features keeps them, unread; the release that squashes the migrations
  resets dev.
- The start's remaining steps keep their order and their numbers; step 5 is gone from it.
