# ADR 0101: A Persona fork's MCP tools are its own

Status: Accepted 2026-10-22 with the owner. Amends ADR 0027 (MCP tools reach the model through `mcp_list` and
`mcp_call`) and ADR 0033 (a Persona's fork), with goblin-52's two conditions (2026-10-21) as its first two decisions.

A Persona reached its setup's MCP tools only through `mcp_list` and `mcp_call`: it listed a connection, named the
tools it wanted to read their schemas, and called one with its arguments as an object or the JSON string of one. Small
models do this badly. A Swarmm logo job spent 73 minutes in 63 model calls, 26 of its 103 tool calls failed, and most
failures were arguments guessed or double encoded; a compaction then dropped the schemas the Persona had listed, and it
listed them again. Every other agent runtime offers a server's tools natively, under the server's name.

## Decision

**One call path, checked at every call.** `mcp_call`'s body is `callRemoteTool` (`pi/remote-call.ts`), and a native
tool calls it too. At each call, in order, it checks the conversation's execution authority (resident, a routine's),
its scope (the Topic's setup joined with the Persona's frozen one, `mcpOff`), the ask-first hold and its approval
card, and then the manager's own checks: dispatch authority and the owner's exact grant right before each HTTP
dispatch (`callTool` → `checks.granted`), and the arguments against the tool's schema as listed now (ADR 0092). URL
requests, Apps the result renders, files it hands over, and the grant, scope and sign-in cards are as for `mcp_call`.
The ask-first hold is prepared in `beforeTool` for a native call as for an `mcp_call` (`nativeCall`). Freezing a set
decides only what the model is offered: a grant revoked or a setup narrowed since runs nothing.

**The set.** When a Persona's fork is registered (`registerPhase`, after `registerFork`, the first moment its scope is
the Persona's), goblin lists each connection its scope holds and takes every tool the model may call (`toolOffered`)
that the scope holds and the owner granted. The set is frozen, stored once per distinct set by the hash of its tools
(`app_persona_tool_sets`, with `app_persona_fork_tools` naming each fork's), installed as one extension the fork
selects, and installed again before Pi opens (`ForkToolsKit.restore`), so a restarted fork offers the same tools. A set
that holds everything the scope does takes `mcp_list` and `mcp_call` away from the fork; one that left something out
(a connection that could not be listed, a tool not granted or refused below) keeps them, so the owner's connect and
Allow cards still work. A fork that goes on after a hold keeps the set it froze. Sets no fork made in 30 days are let go.

**Names, one rule for every app.** Every native tool is `<server>__<tool>`. `<server>` is an alias of the server's own
name (`serverInfo.name`): lower case, `[a-z0-9_-]`, no run of `_`, at most 20 characters. Two connections of one alias
each get a four-character hash of their connection id (`mycut_k3x9__job_submit`), so neither wins by order. The tool's
name keeps `[A-Za-z0-9_-]`, any other character as `_`. The whole name fits `^[A-Za-z0-9_-]{1,64}$`; a longer one is cut
and ends with a hash of the whole. goblin's own tools never hold `__`. Two tools that would share a name are both
refused, since Pi lets the last of two tools of one name win: neither is offered, and the set says so. MyCut connected
directly gives `mycut__job_submit`; a thread's declared server named `swarmm` gives `swarmm__delivery_submit`
(ADR 0102).

**Remote words, bounded.** A native tool's description and schema are a server's words, which the model reads as part
of its tool definitions rather than as a tool's result. goblin cleans them before they are frozen: a description loses
C0 and C1 controls (but tab and line feed), zero-width marks and bidirectional overrides, and is cut at 1,024
characters; a schema's descriptions and titles at 512, the same characters dropped from every string and key; its local
`$defs` are inlined, `format` is dropped (an annotation, ADR 0092), and a schema that is not an object, nests deeper
than 24, is larger than 16 KiB as JSON, keeps a reference it cannot resolve, or does not compile with TypeBox (as Pi
compiles it to check each call) is refused, its tool left out. This is acceptable although AGENTS.md treats remote
descriptions as untrusted: the text is the same the model already read through `mcp_list` in full, it comes from a
server the owner connected and granted tool by tool, it grants nothing (every call is checked as above), and the
fork's context tail says the names, descriptions and schemas are the servers' words, never instructions or
permission. Cleaning keeps the text from hiding words, posing as goblin's structure or growing without bound.

**Size.** Up to 20 tools are offered at once. Above that every native tool is deferred and the fork selects Pi's
`tool_search` (`createToolSearchExtension`): the model finds tools by what they do, and what it loads stays offered on
that branch, after a compaction too, with its full schema.

**Where names are read.** The approval hook, the run recorder (`mcp.server` and `mcp.tool` of a native call, by its
fork's set, content-free as before), the App registry (an App a native call renders launches like an `mcp_call`'s) and
the web all recognise a native call. Its result says what it reached in goblin's own words: a server's result's
`origin` names the tool, and goblin's marker (an approval, grant, URL or sign-in card) names the native tool it answers,
so the web shows the same cards, only for that tool. The static persona section says what a `<server>__<tool>` tool is;
the fork's own tool names are in its context tail with its Persona's text, so the cached prefix does not change.

**Skill text.** A skill a fork reads from a server it has native tools of is asked with `_meta: {"toolPrefix":
"<alias>__"}` on `skills/list` and `resources/read` alike (the listing is cached by prefix, since the prefix changes the
text and its digests), so a server that names its tools in its skills names them as the fork does. Any `{{tool:x}}`
marker left in the text becomes the fork's native name for that server's tool `x`.

**Exposure.** `GET /api/personas/:id` and `persona_get` answer `exposedTools`: the native names the Persona's own setup
gives it now, names only. A Topic that adds servers adds tools to a fork's set, and a thread's declared servers add
theirs (ADR 0102).

## Consequences

- A Persona calls `mycut__job_submit` with typed arguments, Pi checks them against the frozen schema before the call
  and goblin against the live one, and every problem comes back at once.
- A server whose tool schema TypeBox cannot compile has that tool left out of native sets; `mcp_call` still reaches it
  where the set kept it.
- Freezing lists every connection the scope holds when the fork starts, which adds a connect per server to an answer's
  start; a connection that cannot be listed then offers no native tool in that answer.
- Routine runs handed to a Persona still use `mcp_call`.
- A fork that goes on after more than 30 days has lost its set: it has no native tools left, and none through
  `mcp_call` when its set had taken that away.
