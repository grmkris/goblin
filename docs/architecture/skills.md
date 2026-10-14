# Skills

## Skills

Skills come from MCP servers that declare the MCP Skills extension, and only from those the owner turns them on for
in Connections (`app_skill_sources`, ADR 0008). The client declares the extension; `McpConnections.skills` and
`skillFile` speak `skills/list` and `resources/read`, with the shapes decoded in `skills/protocol.ts` because the SDK
has no Skills support yet. The library activates entries from `skills/list`.

The `Skills` service (`skills/library.ts`) keeps each enabled server's listing for its `ttlMs` (30 s to an hour) and names
every skill `<server>:<name>`. The `goblin.skills` extension (main, threads and helpers) renders that list in
its `skills` section, refreshing an expired listing when the section is evaluated, and offers `skill_activate` and
`skill_read`. Activation reads `SKILL.md`, checks size, SHA-256 and frontmatter against the entry (`skills/verify.ts`),
and records the entry for the conversation (`app_skill_activations`). `skill_read` reads only files in that retained
manifest, so a conversation
stays on the version it activated. Verified bytes are cached by digest (`app_skill_files`) and checked again on every
read. A corrupted cache row is rejected and repaired by a verified refetch (local workerd regression evidence). A
local workerd restart preserves the activation manifest and cached bytes, then reads the same version without a network
call.
An unreachable server keeps its last listing while it remains cached in the isolate, or is reported unavailable.
Dynamic skills are declined; skill scripts can be read but are never executed (the only code goblin runs for the agent
is its own apps' and `code_run`'s, in Dynamic Workers; see Agent apps). Enabled skills are procedures the agent
follows, but they grant no permissions and cannot override the owner. Disabling the server stops new activations and
file reads; instructions already in a conversation stay there. A Topic's setup can leave a library out (Setup and
scope): its chats' section leaves it out without fetching it, and their activations and reads are refused. A setup
can also hold single skills, by server and name (a new version keeps its place; a URI is kept only to tell namesakes
apart): the section lists only those, the composer offers only those, and `skill_activate`, a composer selection and
`skill_read` ask the scope about the one skill (`skillScope`'s `(connectionId, { name, uri })`) before anything is loaded or
read, a cached file included. A skill outside the setup refuses with the `not-in-topic` ask.

After a final answer in an owner conversation (`goblin.skill-learning`, `onYield`), the learner (`skills/learner.ts`) looks at the latest user message. On a correction
or a request to keep how something was done, the memory model decides whether the exchange teaches a procedure. A
procedure becomes a draft sent through an enabled library's granted `skill_draft` tool, which the owner reviews in the
library. The Worker logs the learner outcome and conversation id without transcript or draft content. At most five in a rolling 24 hours, never the same content twice, no new draft while one for that skill is open,
and never a rejected draft again (`app_skill_drafts`). A grant for `skill_draft_status` lets the learner refresh review
status; a deterministic workerd test confirms a rejected draft is not submitted again for the same lesson. Draft
payloads contain generated procedure text and brief evidence, with email- and secret-shaped strings
scrubbed, and no transcript field. The learner's model call counts toward the budget.
