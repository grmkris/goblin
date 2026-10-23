# ADR 0115: Every Topic is sealed, and a turn's power is its sender's

Status: Accepted 2026-10-23 (owner); release B built. Supersedes ADR 0108 (moved to the [archive](archive/README.md))
and ADR 0113's keying of a room's object by a Topic a key made. Amends ADRs 0022 and 0065 (files per Topic), 0035
(what search covers), 0087 and 0099 (whose work a turn is) and 0114 (what a turn may do once admitted).

## Context

ADR 0108 confined by place: a Topic a server's key made was a room, and every chat under it, whoever wrote there, the
owner too, was offered a short allowlist of tools. Everything else stayed open: the owner's own Topics saw one another
through search, the workspace's files and apps were all or nothing, and "made by a key" decided what a turn could do.
Release A (ADR 0114) gave every credential one grant, but said nothing of what a turn may do once a message is in.

Kris decided (decisions 9, 10, 11 and 15 of the upgrade plan): every Topic is sealed, with a hub that reaches them
all; files are kept per Topic with one Shared folder; acting on another Topic takes the hub; a turn's power is its
sender's grant, bounded by the Persona's or the Topic's setup; there is no "made by" concept that behaviour depends
on, and rooms go.

## Decision

**Every Topic is sealed; a hub reaches every Topic.** `app_topics.reach` is `sealed` (the default) or `hub`. Personal
is the hub until an admin says otherwise; an admin's person may make any Topic a hub or seal one, a credential with
`manage` may seal one but never make a hub (`Forbidden` `hub_person`). A chat's boundary is its chain root's Topic
(`topics/boundary.ts`: every thread, subagent, Persona fork and routine run is registered in the Topic it came from)
and whether that Topic is a hub.

- **Search.** `search_chats` and automatic retrieval cover the boundary: a hub's every active Topic, a sealed Topic
  itself. A Topic named from a sealed one is `NotFound`, so a sealed Topic cannot tell another exists.
- **Acting on another Topic** (renaming, archiving or setting it up, proposing or pausing its routines) works only
  from a hub (`Forbidden` `boundary`). The Source tools route anywhere in the workspace, so they run only in a hub.
  Making Topics and Personas works anywhere.
- **Files per Topic.** A Topic's files are under `/topics/<id>/uploads` (what people attached) and `/topics/<id>/agent`
  (what the agent wrote, and `received/` for what MCP results hand over). The existing `/uploads` and `/agent` are the
  **Shared** folder: nothing is moved. A turn's view (`files/folders.ts`): a hub's reads every Topic's folder, a sealed
  Topic's its own; either reads Shared only on a person's turn, never on a turn a server's key sent; the agent writes
  only under its Topic's `agent` folder. `code_run` sees the same view. The owner's API reads and writes everything.

**A turn's power is its senders'** (`grants/power.ts`). A person's is their role's (`ROLE_POWER`), an OAuth client's
its grant within its person's role, a server key's its grant, and work no person or credential sent (a Source, a
routine, the system, the agent's own reports) an admin's. Each input's receipt records its sender's power at admission
(`app_chat_operations.power`); a run's power is the intersection over the inputs it took, so a run that batched the
owner's and a key's message does only what both may. A Persona's turn is its asker's; a subagent's message carries
its spawner's power in a receipt of its own, and a synthesized report back carries it again. Where the turn works
bounds it further: the Persona's or the Topic's setup (decision 9: a Persona brings its own tools, joined with the
Topic's), the boundary (a hub's only when no credential whose Topics are a list sent an input), and an MCP connection
only when every credential whose connections are a list lists it. The Shared folder and apps need a person's turn
(apps also run from a hub).

**One table says what each tool needs** (`pi/tool-needs.ts`, the plan's `TOOL_NEEDS`): reads within the boundary for
anyone; `write` to call out, write files, run code and start helpers; `manage` to rename, archive and set up Topics and
to make or change Personas; the `setup` extra for setups, Sources and servers, `routines` for routines, `inspect` for
`diagnose`; apps on a person's turn or from the hub, building one with `setup`. A tool the table does not know is never
offered and never runs. Three layers read it: Pi's tool filter offers each sender's turn what its power reaches
(`piToolsFor`, set at admission by `useTools` whenever what it removes changed), the call-time guard refuses anything
else (`pi/power.ts`, a `beforeTool` hook in every conversation, helper and routine run, deny by default), and each tool
that needs more than a read checks again before it runs (`outsidePower`). What depends on a call's arguments the tool
checks itself: a setup it brings takes `setup`, another Topic it names takes the hub, a connection it calls must be in
the turn's power.

**Tenancy belongs to the sender.** A key's message starts `[from server <name>]`, its receipt's origin is `key`, and
its turn runs on the deployment's models (`Models.forServers`); it never answers a routine's waiting question. The
skill learner never drafts from a turn a key sent input to. A Persona a key tags is told the server asks and never
instructs. Guidance a key writes for a Topic is read as that server's operator guidance, never the owner's
(`app_topics.guidance_by`). Routines and Sources may live in any Topic: a routine is the owner's and runs on the owner's
model.

**"Made by" is display only.** `app_key_reach` becomes `app_made_by`; `TopicView` and `TopicSummary` carry `reach` and
`madeBy` in place of `searchExcluded` and `room`, and the sidebar groups each key's Topics under its name.

## Migration

One forward migration on the agent, `SEALED`: `reach`, Personal the hub; `search_excluded` dropped; `guidance_by`,
the guidance a room had is its key's; `power` on receipts, none on the older ones, which read by their origin (a key's
as `read`, failing closed); `app_key_reach` renamed `app_made_by` with its index. No file moves, no reset.

## Consequences

- The owner writing in a customer's Topic has the owner's power there, within that Topic only; under ADR 0108 they
  lost their power instead.
- The owner's own Topics no longer see one another: cross-Topic search and files are the hub's.
- The hub reaches every customer's Topic. In a server's workspace its customers' Topics are sealed from each other and
  from every non-hub Topic (Swarmm's guarantee 1 now reads so).
- A member's turn no longer renames or archives Topics or lists routines through the agent (`manage`, `routines`).
- The owner API drops `searchExcluded` and `room`; a client that sent `searchExcluded` must stop.
- ADR 0113's room object would now key on a sealed Topic; its later slices wait on a decision of their own.
- Proven in unit tests (`power.test.ts`, `topic-boundary.test.ts`, `retrieval.test.ts`, `topic-reach.test.ts`,
  `files.test.ts`, `migrations.test.ts`) and on local workerd (`sealed-case.ts`, the files probe); the deployed check is
  separate.

## Rejected

- **Confining by place** (ADR 0108). Who sent a turn decides what it may do; the place decides what it may see.
- **Keeping "made by" in behaviour.** Who made a Topic stays a label; a server keeps its customers apart through the
  boundary and its grant's lists.
- **Moving existing files into Topic folders.** Old chips and links stay valid; what was there is Shared.
