# 0068: Events use their standard fields only

Accepted 2026-10-15 with the owner. Amends ADR 0041 (event suggestions) and ADR 0066 (setups a server suggests). Part of
the cleanup that makes goblin MCP-first, with no server-specific code (ADR 0063).

## Context

ADR 0041 (amended 2026-10-12) let a server suggest how the owner sees and sets up its events, under `_meta.suggest` of
each event descriptor: a title, a summary, a group, whether it is worth setting up (`recommended`), whether to tell the
owner (`tellMe`) and how often it happens (`rate`). The picker pre-selected what a server recommended. ADR 0066 added a
whole Source setup there (`_meta.suggest.source`), which the owner set up with one tap. The key has no vendor's prefix
and no standard says what it holds: only goblin's own servers wrote it (mygram, through mysi), so it was
server-specific code by another name.

The Events draft (SEP-3415) has no titles, groups or recommendations. MCP keeps `_meta` for implementation hints under a
prefixed key owned by whoever defines them. A server that wanted its events picked had to learn goblin's private
dialect, and a hint that pre-picked an event let the server decide, a little, what the owner set up.

## Decision

- **goblin reads an event descriptor's standard fields only**: `name`, `title`, `description`, `inputSchema`,
  `payloadSchema` and `delivery`. It reads no `_meta` of an event. The title is folded to one bounded line and the
  description cut (`eventWords`, `mcp/events/protocol.ts`); both are the server's claims, for the owner's eyes.
- **The picker pre-selects nothing.** It lists a connection's events grouped by the service a gateway names them by
  (`<service>.<event>`: the part before the first dot of a name of three parts or more), else flat, each by its title
  (else its name in words) with its description. The owner picks each event they want.
- **No server suggests a Source.** The agent proposes one with `source_propose`, from the event's payload schema, the
  read and reply tools' schemas and the server's skill. The owner confirms or refuses the exact revision, as before.
  The owner API's `POST /api/sources` goes with the suggestions: a setup is drafted by the agent and reviewed by the
  owner, never filled in from a server's hint.

## Consequences

- `EventStream` loses `summary`, `group`, `recommended`, `tellMe`, `rate` and `source`; `EventRate` and
  `SourceSuggestion` go. A descriptor's `_meta` is not decoded at all.
- A server that wants its events used well says so in its standard fields and its skill: a clear `title` and
  `description`, a `payloadSchema` that names the fields a Source points at, and a skill that tells an agent which tool
  reads its inbox and which field marks the owner. The skill guides the agent's proposal; it confirms nothing.
- mysi and its apps may stop writing `_meta.suggest`; goblin ignores it either way.
- Setting up several events takes one tap each in the picker, and a Source takes a turn with the agent and a review.

## Rejected

- **Reading the same hints under a vendor prefix** (`lol.mysi/suggest`): still one server's dialect, the code ADR 0063
  removes.
- **Keeping `recommended` as a pre-selection**: a server would still choose what is picked; one tap per event costs
  the owner little.
