# goblin

Your own goblin, always on. Resident personal agents on Cloudflare. Each user signs up and gets their own agent: they
talk to it in the browser, it keeps running, holds its own authority to use the MCP servers that user connected, and is
itself an MCP server other tools can talk to.

The agent has one stable main chat (`/c/1`); it resolves to the current Pi session. Side threads can start empty or branch from any message of any conversation, at
any depth; they can share a note back to where they came from, and Close stops one with everything under it until it is
reopened. Main learns the name of a thread started empty, and one live feed keeps every open tab's list and activity
current. The web app is a Slack-style shell: one moss sidebar (Activity, Work and Apps, the owner's pins, the Topics as
channels, then Connections, Personas and Settings), the channel (Personal's
is Main), and a thread panel beside it where a message's thread opens, stacking threads opened inside threads. Each Topic has a setup:
the MCP servers and their tools, skills, agent apps and subagents its chats work with, everything until the owner
chooses a list, and a Persona adds its own while it answers there. Background subagents work in their own conversations, start their own when a job splits, post their final
answer in the conversation that started them (attributed, and not answered again unless the job asked for synthesis) and close
when done; the owner can write to one to steer it. Personas are named, versioned agents the owner tags with `@name`: each tagged Persona
answers once, attributed, in the same chat, and Goblin can organize Topics and Personas on request, leaving receipts the owner can undo. Every Topic's Conversation (Main is Personal's) keeps its own OptChat-style memory view: summaries of older messages followed by the
newest exchange verbatim.

Tool calls expand in place to readable input and output, with folding JSON branches, formatted Markdown, full-value
copying and a Raw view.
The agent's replies draw Mermaid diagrams, charts and maps from fenced blocks, in the theme's colours.
Diagrams offer an explorer with zoom, pan and node connections, shared with agent apps. Complete `openui` fences
can show small forms, choices and dashboards using Goblin's components. Their buttons send visible choices and
form values as ordinary follow-up messages; they grant no tool permissions. Field edits reset on reload.

Any connection whose events carry the owner's own messages (a chat app, mail) can become a **Source** the owner
confirms: which messages are theirs, which Topic or Persona each conversation goes to, and how goblin's answer goes
back (ADRs 0066, 0069). Telegram can come through Mygram, directly or through MySI, using that same reviewed Source
setup. MySI brings the owner's my* apps in one connection, and `mcp_list` lists its tools by service. Goblin has no
built-in Telegram switch, transport or routing rules.

**Notify me via** sends a routine's notice copies and an app's notifications through the owner's chosen tool.
Owner-reviewed delivery rules distinguish accepted, retryable, rejected and unknown results; an exact event selector
prevents echoes on shared connections. Unconfirmed delivery stays unknown and is not retried automatically.

Owner-enabled skills libraries use update Events to invalidate their cached
catalog; the next activation refetches, while retained activations keep their verified version. After a correction,
goblin may write a new skill as a draft in the owner's files and tell them in the chat.

Apps run in place in any conversation, several at once, and move to their page (`/a/<id>`, with the way back to its
channel and goblin's composer for that conversation at the bottom) and back without reloading. The sidebar's Pinned
section holds the servers and App views the owner pins, in their order, on every device; a pinned server opens its own
App full screen in a thread of its own. On a phone the navigation is a drawer and a thread is a full view with a back to
its channel. Owners can add public servers by URL, from MCP registries, or from goblin's shelf (mysi, Cloudflare to
publish with, and servers that need no sign-in grouped by what they are for: travel, knowledge, crypto data, views in the
chat, code), grant tools explicitly (every server alike: no code favours one, ADR 0063), mark individual tools
**Ask first** for approval of every exact call, bring their own
OpenAI-compatible model endpoint and key or use the deployment's (a deployment may have none, and then each owner
brings one), choose among its models, and see the day's token usage against the deployment's optional per-account cap.
Allow all and None save the connection's tool permissions together in one request. Allow all keeps existing Ask first settings.
The agent uses
`ask_user` to ask questions the owner answers in their next message. The owner attaches files to a message with the
composer's paperclip; the agent reads them and writes its own results beside them, kept per agent in SQLite and R2.

Messages sent while Main or an ordinary thread works stay visible in a queue above its composer, oldest first,
with their author, files and references. Sending adds a follow-up; it does not interrupt the current turn. The queue
is separate from the transcript until Pi starts that input, and survives refreshes and reconnects.
Each queued message can be removed while it is waiting; a message Pi has already started keeps running.

In the composer, `/` selects skills or `/help`, `/new-thread` and `/stop`; `@` selects connected servers, skills or
helpers. Selections become removable chips. A skill can be sent alone; a helper reference brings its latest report
into the current conversation. Helpers share live execution capabilities and can be narrowed by their parent.

The agent builds apps for its owner from ordinary conversation (ADR 0021): small programs goblin runs in Cloudflare
Dynamic Workers, with durable state, actions and views that become the agent's tools, an optional live UI drawn with
goblin's components, charts, maps and diagrams, schedules that run on their own, and powers (the web,
the owner's MCP tools, a cheap model, notifications, other apps) that each wait for the owner's Allow. The Apps page lists them; an app can
fill the workspace with its conversation docked beside it, roll back to an earlier version, or be deleted.

Every turn can be seen end to end (ADR 0024). Beside Pi's own record, each agent keeps a 30-day run ledger of how its
turns ran: model attempts, tool calls, retries, MCP steps, Source replies, timings, tokens and errors, never content.
Workers Logs and Traces carry the same ids. A coding agent reads the owner's conversations and any turn's timeline
through the read-only inspection tools of goblin's one MCP endpoint, `/mcp` (when the owner grants `goblin:inspect`), or
the `goblin` CLI (`apps/cli`), and the agent answers "why did that fail?" with its own `diagnose` tool.
Diagnostics focus on work needing attention; `problems --all` includes expected waits and recovered model attempts.
Successful background model completions stay out of problems; their failures remain visible.
Private error details stay in conversation inspection; logs and traces carry fixed summaries.
The ledger also records how conversations move, content-free (ADR 0037): sends, threads, moves, share-backs, closes
and Stops, Personas, Delegates, Topics, organize Undo, routines and Source deliveries. A message's
Details shows what ran behind it, every failure the app shows quotes a reference (`… · ref 7f3a9c12`) that
`goblin lookup` finds in the Worker's logs, and `goblin stats` sums flows across every agent of a stage from Workers
Analytics Engine, under hashed agent ids.

**Goblin Wallet**, the agent wallet built for the October 2026 hackathon, has left this repository: its source is kept
at the tag [`hackathon-2026-10`](https://github.com/grmkris/goblin/tree/hackathon-2026-10), and goblin connects to a
wallet like any other MCP server.

Built on the Cloudflare Agents SDK (`PersonalAgent` Durable Object) with the native Pi harness (Pi Durable owns
conversations and execution), Effect for the agent's services and its typed owner API (an Effect HttpApi each user's
agent serves, ADR 0038), TanStack Query in the browser, Better Auth for identity, and Alchemy for infrastructure.

```sh
bun install --frozen-lockfile
mkdir -p .local && cp .env.example .local/local.env && chmod 600 .local/local.env
bun dev            # http://localhost:18971, models through CLIProxy
bun run check      # the full gate (run it through `heavy` on the build box)
```

- [Architecture](docs/architecture.md): how the Worker, the agent object, Pi, MCP and auth fit together, including
  conversations, memory, skills, Sources and MCP Apps.
- [Development](docs/development.md): local setup, the dev stage, connecting servers, adding goblin to Claude Code.
- [Next](docs/next.md): remaining acceptance and write approvals.
- [Decisions](docs/adr/): why it is shaped this way. [Glossary](GLOSSARY.md).
- [Brand](brand/README.md): the mark, app tiles, lockups and social images, with their colours and public URLs.

A visitor who is signed out meets goblin's landing page at `/`; a signed-in owner
goes straight to their chat. The deployment stages are `dev` at `dev.goblin.surf` and `prod` at `goblin.surf`, with separate auth databases,
secrets and dedicated LiteLLM keys. The first production release is invite-only; owner OTP bootstrap is an explicit operator step. Alchemy can attach the custom domains. CI on GitHub-hosted runners deploys every push to `dev` that passes Check to dev; `bun run promote <sha>` fast-forwards `prod` to an accepted dev SHA, and CI then deploys and verifies production.
Alternate hosts redirect to the configured canonical origin. Dev sign-up stays closed or invite-only; prod
supports open sign-up after sender verification. People sign in by emailed code, through the deployment's OpenID
Connect provider, or both ([ADR 0064](docs/adr/0064-openid-connect-and-config-driven-deployment.md)); a deployment
needs at least one, and `/health` lists what it offers. Both stages send codes from `hello@goblin.surf` after sender
onboarding, with a host prefix on dev mail subjects. Everything a deployment differs by is configuration, never its
stage's name: its origin, mail, provider, model endpoint and the optional bindings (large files, agent apps, flow
metrics). See [development](docs/development.md) for the settings, the production guard and smoke.

goblin has no plans and takes no payments ([ADR 0058](docs/adr/0058-no-plans-tokens-and-an-optional-cap.md)): the
sign-up mode decides who gets an account, and every account reaches its own agent and everything in it. Each account's
model tokens are counted per UTC day; a deployment may cap them (`GOBLIN_DAILY_TOKEN_CAP`), and once a capped day is
spent goblin refuses new model calls until 00:00 UTC. Draft terms and privacy pages await operator review.

Several connections to one MCP server are normal: each is the owner's account there, with its own label, sign-in,
grants and webhook (ADR 0041). A routine fires once, on a schedule or when a connection sends an event; it lives in a
Topic and can **Tell me** (each event, reminder and answer is a notice in the Topic and a notification in Activity,
through Notify me via too if asked) and **Hand to** Goblin or a Persona pinned at its revision, with an instruction, exact tool
pairs and budgets. The owner confirms
each revision in Settings → Routines or on the connection's Events section, a picker that names each event by its own
title, sends each one the owner picks to a Topic (Tell me) or hands it to goblin or a Persona, and sets them up in one
step; Goblin may propose one, never confirm it. Run now, Stop, Pause, Edit and Archive are available. Event confirmation
authorizes the exact connection, event name and JSON filters; event text reaches the model only as framed untrusted
data, and controls never start a model turn. A Persona's ask-first call or tool to allow waits under its answer for
the owner, and their decision resumes it. See [the routines decision](docs/adr/0012-routines.md) and
[connections, Tell me and Hand to](docs/adr/0041-connections-tell-me-hand-to.md).

LOCAL throwaway-account acceptance covers routine reminders, cron recovery across a process restart, revoked-authority skips and caps through CLIProxy. Native alarm tests also verify recurring recovery wakes; real producer Events and deployed acceptance remain separate.

Main is the stable chat and composer. The dashboard surface is deferred while its runtime layout data remains available for a later UI iteration. The logical chat identity layer keeps URLs, capabilities, placement and operation admission stable while Pi owns the physical sessions and transcripts; Topics build on it: each Topic is a channel with its own Conversation (a new Pi session, not a fork) and the threads under it, Personal holds Main and receives every inbound channel, and archiving a Topic stops its chats' work until it is restored (ADR 0032). Start thread and Move to thread add Threads as forks, never rebinding a chat (ADR 0034). goblin can search the owner's other chats across active Topics (`search_chats`), adds up to three relevant excerpts on its own when a cheap rerank finds them, and what an answer retrieved is kept as frozen excerpts behind `GET /api/conversations/:id/sources` (ADR 0035).

## Hackathon disclosure

goblin is the author's entry to the Colosseum Crypto World's Fair (14 September to 12 October 2026), and all of it was
built within that window: the repository's first commit is 4 October 2026 and Goblin Wallet was built on 12 October.
The submission is the tag [`hackathon-2026-10`](https://github.com/grmkris/goblin/tree/hackathon-2026-10); the wallet,
paid inference and Pro have since left this repository. goblin draws on prior author-owned work and connects to
external MCP services; those projects are not part of this contest submission. The submission was built on open source
and third-party services: Cloudflare Agents SDK, Pi, Effect, Alchemy, Privy, MetaMask Delegation Framework v1.3.0,
x402, mppx, LI.FI, Relay, viem and shadcn. Built with AI coding agents (Claude Code, Codex).

Goblin-owned code is available under the [MIT License](LICENSE). Third-party terms and author-owned reuse are described
in [NOTICE](NOTICE.md). See [ADR 0046](docs/adr/0046-production-promotion-and-public-source.md) for branches and publication.
