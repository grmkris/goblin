# ADR 0079: Channel info and goal-first Start

Status: Accepted. Amends ADR 0062's step content and kickoff, and ADR 0040's setup entry points.

## Context

Channel settings exposed configuration before the context people need: what a channel is for, what it can use,
what was shared, and what is happening. Start asked for configuration before the owner's goal.

## Decision

A top-right info button opens Overview, Tools & skills, Shared, and Work. Desktop uses a side panel; phones use a
full-screen dialog with Back. `info=true` preserves thread/reply URL parameters and mounted composers. Secondary
channel actions remain in the panel menu. Capability editing uses the existing Topic setup editor.

Description and Instructions belong to the Topic. Both edit with a revision check that preserves a conflicting
local draft. Each model request reads current channel guidance, including threads, helpers, Personas and routines.
Instructions grant no capabilities; exact grants, Ask first and resident authority remain mandatory. A failed guidance
read cancels its generation through Pi's public abort API, using the invocation context so the hook never waits for
itself. This depends on Pi storage accepting the cancellation mark; it is not a guarantee against storage failure.
Remote context cannot forge channel/persona sections; generated retrieval source boundaries retain their separately
escaped fields.

Shared uses paginated authoritative Pi history, independently of compaction and retrieval opt-out. It indexes
visible text and validated files, applies omission edits across pages, and deduplicates inherited fork entries by
Pi's globally minted entry IDs. Media is not fetched for previews. Search describes its loaded scope; older pages
remain available. Work shows only conversations, routines and external source routes belonging to the channel.

Start collects a goal, offers model setup and optional relevant connections, and lets the owner review the first
channel and message. A session draft survives navigation and OAuth. One kickoff call creates the channel, records
the kickoff, sends the goal and finishes Start, each step under an operation id derived from the kickoff's, so a retry
replays it. Its refusals come before anything is made and unlock editing; uncertain outcomes retain the operation.
The kickoff is bound to that logical channel and resolved to its current Pi session. It asks for useful work first,
with a focused question only if needed; Personas and routines are introduced when useful.

## Consequences

The baseline schema gains Topic guidance and a kickoff channel. Deploying the changed baseline requires the
repository's disposable-development reset procedure. This decision does not authorize a production reset.
The Shared view is a paged archive, not a new durable content store or a full-history search service.
