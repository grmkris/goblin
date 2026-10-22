# ADR 0102: Native tools are a Persona's choice

Status: Accepted 2026-10-22 with the owner. Amends ADR 0101 (native tools for every Persona fork) before it reaches
production, after a review of it.

ADR 0101 gave every Persona fork its setup's MCP tools natively. Reviewed before its release, it would have changed how
every existing Persona answers at once (the owner's own and those of servers with paying customers), and its handling of
remote schemas could hang a turn or leave MyCut's main tool out.

## Decision

**A Persona chooses.** Its definition gains `tools`, `native` or `gateway`, optional (`PersonaTools`); absent is
`gateway`. It is stored on the Persona and on each revision (an additive migration), frozen with the revision an answer
uses, and carried by the Persona endpoints and their `/mcp` tools (`persona_create`, `persona_update` with
`tools: null` back to the gateway, `persona_get`, `persona_list`) and an organize Undo. A `gateway` Persona's fork
answers exactly as before ADR 0101: nothing is frozen, and `mcp_list` and `mcp_call` reach its tools. A `native` one's
fork freezes its set as ADR 0101 says. `exposedTools` is empty for a `gateway` Persona, so a server checking a
Persona's native tools before it hands it work refuses one that has not chosen them.

**Freezing never holds a turn back.** A set that cannot be frozen leaves that fork on the gateway, with one content-free
`mcp` log line (`where: fork_tools`, `kind: gateway`, the failure's type); the Persona detail answers no exposed tools
when they cannot be read.

**Remote schemas are walked once, bounded.** Local references are inlined with a guard against a reference inside
itself and a bound of 20,000 nodes on what inlining makes, so a few self-references cannot multiply into minutes of
work. The size bound is 64 KiB of JSON, measured after descriptions are cut (MyCut's `job_submit` is about 27,000
characters). Values that are data, not schema, keep every key (`format` inside a `const` too): `enum` and `const` are
refused past 256 items or 512-character strings, since cutting them would change what is allowed; `default` and
`examples` (at most three) are cut. A set stays under 512 KiB in all.

**Hidden characters.** Besides ADR 0101's, remote text loses tag characters, variation selectors, line and paragraph
separators, the Arabic letter mark, the Mongolian vowel separator, soft hyphens and lone surrogates, and is cut by code
point, so no surrogate is left alone.

**The Persona's own tools first.** Up to 20 tools are offered at once, the Persona's own (its own setup holds them)
before what its Topic adds; past 20 the rest are deferred to `tool_search`. A Topic that holds everything never hides
the tools the Persona was made for.

**What a fork is told.** The shared static prompt stays as it was before ADR 0101, so its cache holds. The fork's context
tail says what its native tools are, and either that it has no `mcp_list` or `mcp_call`, or which tools of its setup
were not offered natively (by connection and name, at most 20) and that `mcp_call` reaches them. A skill's `{{tool:x}}`
for a tool the set does not hold becomes the server's own name `x`, never a native name that does not exist.

## Consequences

- At release no Persona answers differently; a server opts its Personas in, one by one, and can opt them out again.
- A Persona whose Topic holds many tools still finds its own first.
- A schema that cannot be walked within the bounds leaves its tool to `mcp_call`, named in the fork's context tail.
