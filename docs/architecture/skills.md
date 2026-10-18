# Skills

## Skills

Skills come from MCP servers that declare the MCP Skills extension, and only from those the owner turns them on for
in Connections (`app_skill_sources`, ADR 0008). The connection’s Skills section groups the trust switch with its
current skill count, names and descriptions; eight entries show first, with the remainder expandable. The list uses
`GET /api/setup/catalog` only while skills are enabled, and shows loading, empty and unavailable states.
The client declares the extension; `McpConnections.skills` and
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

After a final answer in an owner conversation (`goblin.skill-learning`, `onYield`), the learner (`skills/learner.ts`)
looks at the latest user message. It runs only while the owner uses skills from some server. On a correction or a
request to keep how something was done, the memory model decides whether the exchange teaches a procedure: a new
skill, or an improvement of one the conversation used. A procedure becomes a draft in the owner's files,
`/agent/skills/drafts/<name>.md` (a `SKILL.md` with its name and description, then the steps), and the owner is told
with a notice in the chat the lesson came from (`notice:skill-draft:<hash>`, label "Skill learner", what taught it as
its body), which Activity lists ([ADR 0063](../adr/0063-mcp-first-no-server-specific-code.md)). What becomes of a
draft is the owner's choice; the learner calls no server's tool. It writes at most five drafts in a rolling 24 hours,
never the same content twice (`app_skill_drafts`, its log), and never over a draft still in the files: once the owner
moved or removed it, the skill may be drafted again. The Worker logs the learner outcome and conversation id without
transcript or draft content. A deterministic workerd test confirms an improvement is written once and the same lesson
again is a duplicate. Drafts contain generated procedure text, with email- and secret-shaped strings scrubbed, and no
transcript. The learner is built after the start, over the owner's files and the routines' notices (`LearnerLive`).
The learner's model call counts toward the budget.
