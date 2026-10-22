# ADR 0096: A Source configures itself from its server's guide

Status: Accepted 2026-10-22 with the owner, as the goblin part of Telegram through mygram as pure MCP. Amends ADR 0066
(how a Source is proposed: from the server's guide, by the names the connection lists, by the agent alone) and ADR
0072 (result rules are required when the reply tool describes its result). Amends ADR 0068's picker, which lists events
by their own titles, extends ADR 0073's lease recovery to a renewal answered with another subscription id, and removes
the name helper ADR 0052 kept for an app's two spellings.

## Context

A Source's setup (ADR 0066) is JSON pointers and templates the agent proposes and the owner confirms. Setting one up
for a real chat app showed what the agent could not see or do:

- `mcp_list` showed a tool's input schema but not the output schema its read pointers and result rules point into, nor
  the server's own instructions, which say where its guide skills are. The recipe for goblin lives in such a guide
  (mygram's `Driven from a client`), and goblin knows no server by name (ADR 0063).
- A reply with no result rules is an unknown outcome every time (ADR 0072), and an unknown outcome notifies the owner:
  each answer that went out told them so.
- A refused proposal reached the agent as one line cut at 80 characters, so it never read which pointer to fix.
- An app's names differ by path: its own (`post_reply`) directly, a gateway's (`notes_post_reply`) through one.
- A gateway that starts reaching an app through another of the owner's accounts answers a lease renewal with another
  subscription id, which goblin refused on every sweep.
- An outbound sign-in finished by a browser whose person is not in the workspace its state names ended in a bare 404.

## Decision

**A setup starts from the server's guide.** `mcp_list` on one connection carries the server's `instructions` (from its
`initialize`, untrusted data like the rest of the listing, cut to 2000 characters) unless the model named the tools it
wants, and a named tool comes with its `outputSchema` when it declares one. The Sources guide and `source_propose` tell
the agent to start from the connection's guide skill (activated with `skill_activate`, when the owner turned skills on
for it: the agent follows its steps and it grants nothing, ADR 0008), to check the recipe against the listed events and
tools, and to use each name exactly as this connection lists it. No code knows an app's names: the helper that spelled
them (`service-names.ts`) goes.

**Result rules are required when the reply tool declares an output schema.** A proposal without them is refused, and
the refusal names the fields of that schema that list their values (`/status ("sent", "retryable", "rejected")`). Each
rule's `equals` must be one of the values the pointed field's `enum` or `const` (or its branches') allows. A reply tool
that says nothing of its result may go without rules: its outcomes stay unknown, and the Source's card warns that the
owner hears of every answer.

**A refused proposal shows every problem whole**, up to 2000 characters, so the agent fixes them in one more call.

**Only the agent proposes a Source**, so a Source keeps no proposer: `proposedBy` leaves the view, and a forward
migration drops `app_source_setups.proposed_by`, so production keeps its agents.

**A renewal answered with another subscription id moves the lease to a fresh generation.** The lease behind that
callback URL is no longer the one goblin holds; goblin subscribes a fresh callback generation in its place (the same
local id, consumers and cursor), then unsubscribes the old generation by its exact name, arguments and URL, best effort.
Since a producer keys a subscription by selector and URL, the old generation's cleanup cannot touch its successor, as
ADR 0073 requires. A second change of id within the same renewal is the producer's error.

**A refused outbound sign-in explains itself.** The edge still refuses a callback whose person is not a member of the
workspace its `state` names, so its code reaches no agent (no one plants their own sign-in in someone else's
workspace), but sends the browser to `/connect-elsewhere`: "This sign-in belongs to a workspace your account isn't in.
Finish it signed in as an admin of that workspace." The page names no workspace. A `state` goblin did not make is
still the 404 envelope.

**The event picker lists a connection's events by their own titles**, in the server's order, and an event without one
by every part of its name: nothing reads a gateway's `<service>.<event>` shape.

## Consequences

- A Source confirmed before this on a reply tool that declares an output schema keeps running; confirming or resuming
  it again needs result rules, which the owner adds from its card.
- Until an app lists its own names the way a gateway does, a guide's names and the connection's can differ; the agent
  goes by the listing, and the fixtures prove both spellings.
- Without skills on for the connection, the agent sets a Source up from the listing alone.
- An unnarrowed listing costs up to 2000 more characters in the model's context.
- An old lease a renewal moved away from may last until its finite expiry; its deliveries are not taken. Deliveries
  still queued for it are finished, as any replacement's are.
- Tests keep to neutral names too: the retired-terms gate now covers every app's and package's tests (not hosts, which
  tests pin for the stage configuration and the shelf).

## Rejected

- **A recipe for one server in goblin**: ADR 0063. The server says how in its own guide.
- **Taking the new id in place**: the old generation could then only be ended by its URL, which is now the new lease's.
- **Result rules for every reply**: a tool that describes no result has nothing a rule could point into.
- **Naming the workspace on the refusal page**: a link must tell a non-member nothing about a workspace.

## Verification

Unit: `sources-setup.test.ts` (required rules, allowed values, a mail-shaped setup read from the event's data),
`resident-mcp.test.ts` (output schemas, instructions), `mcp/events-renewal.test.ts`, `http/api/edge.test.ts`,
`sign-in-elsewhere.test.tsx`, `migrations.test.ts`, `tools/test/terms.test.ts`. Local workerd: the native
`source-propose` canary and its gateway case, where the scripted model activates the guide skill, lists, is refused
without rules, proposes with them, and a confirmed post comes in as the owner's turn whose answer is accepted with no
notice. The live mygram and mysi run is separate evidence ([development guide](../development.md)).
