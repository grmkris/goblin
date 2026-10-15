# Topics, Personas and memory

## Topics

A Topic ([ADR 0032](../adr/0032-topics-and-per-topic-memory.md)) is a channel with exactly one Conversation and any
number of threads. `app_topics` holds them (`storage/topics.ts`); Personal is Topic 1, seeded by the additive
`20261026000000_topics` migration with Main (chat `1`) as its Conversation, and `app_conversations.topic_id` (default
1) puts every chat in one. `role` is `primary` for Personal's Conversation, `conversation` for another Topic's; both
keep `kind = 'main'`. `Chats` answers `isConversation`, `topicOf`, `conversationOf(topic)` and
`conversationAbove(chat)` (functions of the database in `chats/directory.ts`); `primary` stays Personal's
Conversation, where inbound MCP clients land; Sources use the route the owner confirmed.

Each Topic has a **setup** ([ADR 0040](../adr/0040-topic-and-persona-setup.md)): its MCP servers, skills and agent apps,
each `all` or a list, and whether its chats may start subagents (`TopicSetup`, `packages/contracts/src/setup.ts`).
`app_topics.setup` stores it as JSON; the additive `20261028000000_topic_setup` migration gave every existing Topic,
Personal included, everything. A row that cannot be decoded reads as nothing chosen (`topics/setup.ts`), never as
everything. `editTopicSetup` (`topics/program.ts`) changes it as one new revision: a whole setup compare-and-set, or
items added or removed (`withItems`/`withoutItems`; removing from a category that holds everything lists what
`setupCatalog`, `setup/catalog.ts`, says the owner allows now). The agent may add only what the owner allows now; the
owner may keep or restore an item that is gone, which stays listed. A real change leaves a `topic.setup` receipt whose
Undo restores the setup before it, applies the Pi filter again to the Topic's chats when subagents changed
(`retoolTopic`), and answers the routines it leaves without some of their allowed tools (`routinesOutside`). The
`<apps>` context lists only the apps a chat's scope holds, and a new agent app built in a Topic that lists its apps
joins that Topic's setup with an agent receipt (`newAppJoinsTopic`; a failure there leaves the build as it is).

`TopicRegistry` (`topics/registry.ts`, a store behind the `Topics` service in `topics/service.ts`) creates a Topic
with a new Pi session as its Conversation, not forked from Personal's: its tool filter follows its setup's subagents,
and nothing is copied from Personal. Create is idempotent by operation id and serialized by the service's `KeyedLock` (key
`topics.create`), so a retry or concurrent repeat finds one Topic and one Pi session; active
names are unique ignoring case (409). A Topic's Conversation is never renamed or closed directly and takes its Topic's
name. Branches, "+" threads (`CreateConversation.topic`) and subagents inherit their parent's Topic, and a "+" thread
announces itself in its Topic's Conversation. Archiving (`topics/program.ts`) marks the Topic and then stops each open
chat's work through the owner's Stop (runs, queued inputs, subagents and routine runs); its chats refuse new work
(`topic_archived`) until Restore, which restarts nothing. Personal is never archived. Schedules are untouched.

| Route | Purpose |
| --- | --- |
| `POST /api/topics` | `CreateTopic` (`{ name, operationId, setup? }`): a new Topic and Conversation, with that setup or everything, or the one that operation made; 201. |
| `PATCH /api/topics/:id` | `UpdateTopic`: rename, archive or restore, and the automatic-search opt-out; one new revision per change. |
| `PATCH /api/topics/:id/setup` | `TopicSetupEdit`: a whole setup (409 unless `expectedRevision` is current) or items added or removed; answers `TopicSetupSaved`, the Topic and the routines it leaves without some of their tools. |
| `GET /api/setup/catalog` | `SetupCatalog`: the servers with the tools the owner granted the model, the skill servers they turned on with the skills each lists, and the agent's apps. |

They are the owner API's `topics` group (`topics/api.ts`); the web reads the Topics, archived ones included, from the
workspace feed. Its snapshot lists `topics`, a change is
`{ type: 'topic', topic }`, and each `ConversationView` carries `topic` and, for a Conversation, `conversation: true`.
Its `attention` (`attention.ts`) lists what in that chat waits on the owner for the Activity rail: the asks since its
newest user message from goblin's own tool-result markers (`ask_user`, a grant request, something outside the Topic's
setup), its
pending held MCP calls, and the unanswered powers of agent apps living there.
Unit tests run the real migrations in `node:sqlite`; the local workerd owner case `topics-case.ts` runs in both
native profiles. Neither is deployed-stage evidence.

## Personas, organize receipts

A Persona ([ADR 0033](../adr/0033-personas.md)) is a named, versioned agent definition the owner tags with `@name`. The
registry (`personas/registry.ts`, `Personas`) keeps `app_personas` and every revision in `app_persona_revisions`;
updates are compare-and-set on `expectedRevision`. A send with Persona selections (`submitOwner`, `personas/ask.ts`)
admits the operation, records one `app_persona_invocations` row per Persona, writes a passive `app.persona_ask` entry
(no Goblin run starts) and creates one background `goblin.persona-turn` task per Persona, guarded by an
`app.persona-asks` document. A turn (`pi/persona-turn.ts`) forks the chat at the ask entry (in a sequence, at the
previous Persona's answer), prompts the fork with the frozen revision text in the context tail, and passive-writes the
answer back as an attributed `app.persona` entry holding the revision. The fork is a hidden `persona`-role thread of
the chat's Topic with main's memory and the delegating, organizing and asking tools removed. A Persona's **setup**
(`PersonaSetup`, ADR 0040) is the MCP servers, skills and apps it adds to the Topic's: the ask freezes it with the
revision, `registerPersona` keeps it in `app_persona_chats` (by the fork's chat) before listing the fork, and the
fork's scope is its Topic's setup, read live, joined with it, never with subagents; its refusals are words only.
Stop aborts the chat's turns and marks their invocations `stopped`.

A Persona's turn can need the owner (ADR 0041). A fork acts while the chat it answers in is open
(`actingChatSession`, `Conversations.requireActing`), so an ask-first call it makes is held as any other. When its
turn stops on goblin's own `approval-required` or `grant-required` marker (`heldCall` in `attention.ts`; a result with
an `origin` never counts), the answer it writes back carries `hold: { kind, approvalId?, connectionId, name, fork }`
and its invocation settles `answered`. The owner's reply goes on in the fork: a decided approval's continuation
(`approval-owner.ts`) routes a fork's session to `resumePersona` (`personas/ask.ts`), as does
`POST /api/personas/reply` after the owner allowed the tool; it records a new invocation and creates a
`goblin.persona-turn` task with `resume: { fork, text }`, which skips the fork and asks it again, then writes the next
answer. Activity's **Needs you** lists the forks' pending held calls with the chat's own (`storedAsks`) and a
Persona's tool to allow from its answer until its next one (`openAsks`), each with `persona`. The web draws the hold
under the Persona's newest answer only (`settledHolds`, `components/parts/persona-hold.tsx`), from the `app.persona`
entry and never from a tool result: an Approval card decides the held call, and a Grant card naming the Persona allows
the tool and replies to its fork.

| Route | Purpose |
| --- | --- |
| `POST /api/personas` | Create one (`CreatePersona`, idempotent by operation id; 201). |
| `GET /api/personas/:id`, `PATCH /api/personas/:id` | One with its revisions, or a new revision (`UpdatePersona`; 409 unless `expectedRevision` is current). |
| `POST /api/personas/reply` | The owner's reply to a Persona's hold (`PersonaReply`; 202): its fork goes on and answers again. |
| `POST /api/organize/:id/undo` | Undo one receipt (409 `touched` after a later edit, `undone` after an Undo). |

The organize tools (`pi/organize.ts`: `topic_create`, `topic_rename`, `topic_archive`, `topic_setup`,
`persona_create`, `persona_update`) act only on the owner's direct request and write a receipt (`app_organize_receipts`)
with the target before and after; the same change from the UI writes one with actor `owner`. `topic_create` and the
Persona tools take a setup, and `topic_setup` adds to, removes from or replaces a Topic's (ADR 0040); the agent may only
add what the owner allows now (`refuseUnallowed`, `setup/catalog.ts`), its tool result names the routines a change
leaves without some of their tools, and the guide tells it never to use them to get past a refusal. A Persona's fork
has none of these tools. The workspace feed carries `personas`
(archived too), `invocations` and `receipts` (newest first) and the matching changes; the web lists them from it. Unit
tests (`personas.test.ts`) run the real migrations in `node:sqlite`; the local workerd owner cases in `persona-case.ts`
run in both native profiles. Neither is deployed-stage evidence.

## Cross-Topic retrieval

[ADR 0035](../adr/0035-cross-topic-retrieval.md). The transcript index (`retrieval/index.ts`, functions of the agent's
database behind the `Retrieval` service) keeps an FTS5 index (`unicode61`, `bm25`) over one bounded, redacted excerpt
per indexed Pi entry: `app_transcript_excerpts`, the external-content `app_transcript_fts` with its triggers,
per-session progress in `app_transcript_index`, and the frozen sources of each use in `app_retrieval_uses` (migration
`20261026000300_transcript_index`). It reads Pi through `Conversation.entries` in entry-id windows and keeps only
entries the session owns (`entry.conversationId`), so forked history is indexed once under the chat that wrote it;
persona forks are skipped. Inputs, answers, share-backs, Persona answers, Delegate results and Topic seeds are
indexed; tool traffic is not. The `goblin.retrieval` extension (`pi/retrieval.ts`, in the default list, so in every
Conversation and thread but not in subagents or routine runs) catches its conversation up after each response, and
every search first catches up about 400 entries across chats. Each catch-up of a session holds that session's turn of
the agent's `KeyedLock` (`retrieval:<session>`), so two never read the same windows at once.

`search_chats { query, topic? }` turns the query into quoted literal terms joined with `OR`, ranks the top 20 hits,
groups them into ±2-entry ranges per chat and returns at most five sources with excerpts of at most 1,200 characters,
marked as quoted history. Without `topic` it searches active Topics that take part in search; a named Topic (name or
id) is searched alone whatever its state. The asking chat is never searched. Each call records its sources under
`tool:<session>:<call id>`, so a replay returns the same result; `details` is `SourcesDetails`.

Automatic retrieval: on the first model request after an owner input in a Conversation or thread (never a persona
fork), the `beforeRequest` hook searches the input's indexed text over the default Topics (never the asking chat), and
when a candidate passes the bm25 gate (-5 at 3,000 excerpts, scaled down by log size for smaller indexes) the cheap
model reranks up to eight with constrained JSON and may abstain (`model.aux` purpose `retrieval`, metered into the
daily budget; skipped once it is spent). At most three chosen sources go into the trailing `<goblin-context>` block as
a `<sources>` part for that request only, and the use is recorded as `auto:<session>:<input entry>` with `inputEntry`.
The task's memo `goblin.retrieval:<input entry>` keeps the choice (or the abstention), so later requests of the turn,
retries and recoveries re-inject the same sources without another rerank. No transaction spans the rerank.

## Topic memory

Every Topic's Conversation (Personal's is Main) keeps its own memory (ADR 0032): `ChatMemory`
(`memory/chat-memory.ts`) keys every row by chat id (its tables are functions of the agent's database in
`memory/store.ts`), and the `Memories` service turns one on with the `goblin.memory` and `goblin.recall` extensions
(`activate`, once; composition activates every Conversation that has none yet, and creating a Topic activates its
Conversation) and forgets a moved turn (`truncate(chat, size)`).
Activation, entry reads and builder writes resolve the chat's current Pi session on each use, so no memory row
names a session. The Builder document uses the generation API's `conversationId`; the builder works only for a
Conversation (`chatOf`, then `isConversation`). The additive migration `20261026000100_chat_memory` copied Main's
agent-wide memory into chat `1` with every idx, entry id and node unchanged; the old tables stay, no longer read.
Memory log entry ids remain Pi's globally unique ids.

A Conversation never ends, so it keeps a memory instead of an ever-longer context (`memory/`, after VictorTaelin's
OptChat gist). Every message of it since the memory was activated is logged in `app_chat_memory_log` with its Pi
entry id:

- the owner's and other authors' words, notes shared from threads, and the notes naming threads started with "+";
- the agent's replies, with their tool calls;
- tool results.

System entries and thinking are never logged. Memory text keeps at most 12 000 JavaScript string units from each
message's head and tail, plus a truncation note (`memory/log.ts`); Pi retains the original entry. This also bounds a
single-message `zoom`.

A background builder task (`pi/memory.ts`), which a Conversation starts after each of its responses, summarizes each
message in order into one line of about 512 bytes with the memory model. It then merges adjacent lines in pairs into a
binary tree (`app_chat_memory_nodes`). A short message, or a pair that fits, is its own line word for word, with no model call.
An empty reply uses up one of a line's three tries; when all three come back empty, the line keeps its source cut to
size, so one message cannot stall the builder. The view folds the tree toward 48 000 bytes (`memory/tree.ts`): one
line per recent message, and older lines covering more messages, merging the pair that is oldest relative to its size
first. Only the merges the view needs are built.

The builder writes the view into its Conversation as an `app.memory` entry, a Pi write submission whose head is that
Conversation's newest input, which is how Pi places a compaction. The model then sees the view and, verbatim, everything from that input
on, so nothing waits for the summarizer. A new view rewrites the start of main's context, which empties the
provider's prompt cache, so the builder places one only once main has run past the last view by an estimated 30 000
tokens (`FOLD_TOKENS`, `memory/memory.ts`); until then the newer messages stay verbatim after the old view.
`zoom(id, n)` (the `goblin.recall` extension) opens a line into the two under it, down to a single message. It is
offered in a Conversation and in threads branched from it, and reads the memory of the Conversation above the caller
(`conversationAbove`); a branched thread is bounded at its fork.

The summarizer's tokens count toward the budget, and the builder stops once the budget is spent. The memory begins at
activation: older history stays in Pi, out of the model's context once the first view lands. Once a view or a
compaction starts a conversation's snapshot later, the web reads the earlier entries through
`GET /api/conversations/:id/history?before=<entry>`; it never shows the marker entries themselves. Settings shows how many
messages main remembers; `GET /api/agent/memory?chat=<id>` reports the memory of that chat's Conversation (Personal's
without one). Unit tests prove the copy migration and per-chat isolation and truncation in `node:sqlite`; the local
workerd case `native-topics.ts` proves two Topics remember apart with each view placed only in its own Conversation.
