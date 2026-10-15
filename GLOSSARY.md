# goblin

goblin gives every user a resident personal agent: their own Cloudflare Durable Object that talks with them, keeps
working while they are away and acts with the MCP connections they granted. These are the words the code, the docs
and the app use for it.

## People and authority

**Owner**:
The user an agent belongs to. Every signed-up user owns exactly one agent and reaches only that one.

**Agent**:
The owner's resident agent, one `PersonalAgent` Durable Object named by the owner's user ID.
_Avoid_: bot, assistant instance

**Resident authority**:
The agent's own standing permission to use the owner's MCP connections while the owner is away. It lasts 30 days,
renewed by the owner's activity, and the owner can revoke it in Settings.

**Inbound client**:
An MCP client (Claude Code, another agent) the owner authorized to call goblin's `/mcp`.

**Grant**:
The owner's permission for one tool of one connection. A tool grant also covers the App that tool declares.

**Suggested access**:
goblin's suggestion for each tool from its annotations (ADR 0060): run when needed for one that says it only reads,
ask first for every other. It applies only when the owner taps Use suggested access.
_Avoid_: recommended access

**URL request**:
A server asking the owner to finish something on its site (approve a new agent, a role) before a call can complete.
The owner opens the link, then presses Done (goblin retries the call) or Cancel (ADR 0042).
_Avoid_: elicitation (in the app), prompt

**Step-up**:
Signing a connection in again with more access, when a call needs a permission its sign-in was not granted
(ADR 0042).

**Setup**:
What a Topic's chats work with: its connections, skills, agent apps and whether they may start subagents, each all of
what the owner allows or a list (ADR 0040). A Persona's setup is what it adds to the Topic's. A setup chooses; it never
grants.
_Avoid_: capabilities, switches, toolset, plugin

## Conversations

**Chat**:
Any conversation the agent keeps (a Conversation, a thread, a subagent), named by a stable chat id that resolves to
its current Pi session.

**Topic**:
A channel of the owner's work: exactly one Conversation and any number of threads under it (ADR 0032). Personal is
the first Topic and holds Main.

**Conversation**:
A Topic's one long-lived chat. It never closes and keeps a memory instead of an ever-longer context.

**Main**:
Personal's Conversation, chat `1`. The owner's browser, inbound clients and Telegram talk in it, each message from
anyone but the owner's browser labelled with its author.
_Avoid_: root session

**Channel**:
A Topic's Conversation as the web shows it (`/c/<id>`, ADR 0036): `#` and the Topic's name in the sidebar.

**Thread**:
A side conversation in a Topic, branched from a message of any open chat or started empty under its Topic's
Conversation. Nothing in it reaches its parent unless the owner shares it back.

**Start thread**:
Sending a message as the head of a new Thread instead of into the channel; Reply in thread and "+" start one the same
way, one Thread per operation (ADR 0034).

**Move to thread**:
Moving a channel's newest finished turn into a new Thread, leaving the owner's message in the channel as the Thread's
head (ADR 0034).

**Thread panel**:
Where the web shows a thread beside its channel (a full view on a phone), threads opened inside it stacked with a back
crumb.

**Close**:
What the owner does to a thread or subagent instead of deleting it: it and everything under it stop and take no
messages, stay readable, and Reopen brings it back. A Conversation never closes.
_Avoid_: delete

**Read mark**:
When the owner last saw a chat's newest reply, kept by the server so every device agrees what is unread.

**Subagent**:
A background chat that a conversation starts with `subagent_spawn` to do one job. It posts its result back to its
spawner once, which does not answer it unless the job asked for synthesis, and closes when done.
_Avoid_: worker, child agent

**Delegate**:
A subagent as the owner meets it in Tasks and the transcript: its result arrives marked with its name.

**Persona**:
A named, versioned agent definition the owner tags with `@name`; each tagged Persona answers once, attributed, in the
same chat, without a Goblin run (ADR 0033).

**Organize receipt**:
The record of a change the agent made to a Topic or Persona at the owner's request, with the target before and after.
The owner can Undo it while nothing has touched the target since.

**Memory view**:
A Conversation's memory as the model reads it: one-line summaries of older messages, followed by the newest exchange
verbatim. `zoom` opens a line.

**Model endpoint**:
Where the agent's model calls go: the owner's own OpenAI-compatible endpoint and key, set in Settings and sealed in the
agent, else the deployment's (ADR 0059). The models it lists are the ones the owner picks from. A deployment may have
none of its own (ADR 0064); then every model call is refused (`NoModelEndpoint`) until the owner brings theirs.
_Avoid_: provider, inference plan

**Memory model**:
The cheap offered model (`GOBLIN_MEMORY_MODEL`) for thread titles, memory summaries and skill-draft decisions; its
tokens count toward the daily usage.

## Work on its own

**Routine**:
What the owner confirmed to happen on a trigger (once, a cron schedule or an MCP Event of a connection) in a Topic:
**Tell me**, **Hand to**, or both (ADRs 0012, 0041). A routine that hands over runs in its own run conversation and
reports back passively.

**Tell me**:
A routine's choice to notify the owner of everything it posts: an event's notice, a reminder, the answer of whoever it
handed to. Optionally each one is also sent on through **Notify me via** (its **copy**, ADR 0070).

**Hand to**:
Who a routine gives the work to: nobody, Goblin, or a Persona pinned at the revision the owner confirmed, each with
the owner's instruction, allowed tools and budget.

**Notice**:
What Tell me posts for an event or a reminder: a short message in the routine's Topic, attributed to the connection
(or the routine), plain text with at most one link. The model reads it as untrusted data, never an instruction.
_Avoid_: alert, ping

**Notification**:
A routine post the owner asked to be told about: listed in Activity's Notifications, counted in the Activity badge
until read.

**Telegram channel**:
The one MCP connection that carries Telegram for the agent (ADRs 0009, 0011, 0055): mygram's, directly or through
mysi, woken by its signed MCP Events. Every chat the grant reaches (the owner's DM, groups, forum topics) has a
**Telegram route**: the Topic its messages become turns in, answered by goblin or a Persona back in the same place, or
kept as notes, or ignored; a new chat waits for the owner's choice. Answers go back through mygram's send tool.

**Source**:
An MCP connection whose events carry the owner's own messages into goblin and goblin's answers back, by a **Source
setup** the owner confirmed (ADR 0066). Any server that sends events can be one (a chat app, mail); none is known by
name. Its conversations each have a **Route**.
_Avoid_: channel, integration, bridge

**Source setup**:
The five facts of a Source, confirmed at an exact revision: the event that wakes it, the key that names a
conversation (JSON pointers into a message), which messages are the owner speaking (the speaks-for-me rule; anyone
else's are notices or dropped), how the content is read (the event's data, or a tool from a cursor, with optional
pointers to the conversation's title and the message's attachments) and, optionally, the tool an answer goes back
with; plus where a new conversation goes (a route, or a new Topic of its own). Only the agent proposes one. Bound to
the connection's endpoint and the grants of its tools: a change of either pauses it for review.

**Route**:
Where one conversation of a Source goes: turns in a Topic answered by goblin or a Persona, notes in a Topic with no
turn, nowhere, or held (the twenty newest) until the owner chooses. A change leaves an organize receipt with Undo.
_Avoid_: mapping, binding

**Own turn**:
The owner's message that came from elsewhere and that goblin marks as theirs after its words (a Source's message the
speaks-for-me rule matched): the web treats it as a turn the owner took. Nothing in the words can mark one.
_Avoid_: owner message, on its own

**Notify me via**:
The owner's choice of one connection's tool, with a `{{text}}` template, that sends goblin's notices to them elsewhere
(their own chat, say; ADRs 0066, 0070; `NotifySink` in the code): a routine's notice copies and an agent app's `notify`
go through it, as goblin's own call under the owner's grant of that tool.

**Conversation activity**:
What a chat is doing now: `working`, or `waiting` on its subagents.
_Avoid_: activity, on its own

**Activity**:
The rail's page of what waits on the owner across Topics: questions, approvals and grants in chats (a Persona's
included), agent apps whose schedules need the owner, notifications, connections whose events are not set up yet,
unread chats, and organize receipts to Undo.

**Tasks**:
The rail's page of work under way: Delegates, Personas answering and routines on a schedule.

**Home**:
The rail's first place: the channel this tab showed last.

## Connections, skills and apps

**Server**:
An MCP server's address, with the claims on its card (title, description, icon) that only the owner sees.

**Connection**:
The owner's account on a server, with a label they give it (e.g. "Sidequest · Hirer"), configured by the deployment
or added by URL, suggestion or registry. One server may have several. Each has its own sign-in, grants, ask-first
settings, skills switch and Events subscriptions (ADR 0041).
_Avoid_: server (for the account), integration, account

**mysi**:
The owner's own my* apps (notes, browsers, Telegram, email, skills, terminals) behind one sign-in and one connection
(ADR 0052). A product of its own, which the owner gets themselves.
_Avoid_: myapps (the code base behind it)

**Service**:
One app behind a gateway connection such as mysi. Its tools and Events carry its name in front (`mygram_inbox_read`,
`mygram.message.received`).
_Avoid_: server (the gateway is the server)

**Shelf**:
The servers goblin suggests on Connections and Start, in groups, each in goblin's own words; one tap adds and
connects. It is data a deployment may change with `GOBLIN_MCP_SHELF` (ADRs 0052, 0061).
_Avoid_: catalog (that is the registry search), marketplace

**Skill**:
A procedure served by an MCP server through the MCP Skills extension. The agent follows skills only from servers the
owner turned skills on for, activates them per conversation as `<connection>:<name>`, and a skill never grants a
permission (ADR 0008).

**Skill draft**:
A skill the agent wrote to the owner's files (`/agent/skills/drafts/<name>.md`) after a correction, with a notice in
the chat; what becomes of it is the owner's choice (ADR 0063).

**MCP App**:
A sandboxed `ui://` resource served through the MCP connection that answered its tool call. One live App moves
between its place in the transcript and its page (`/a/<id>`), where goblin's composer stays at the bottom, without
reloading.

**Server App**:
A connection's own App (its global entrypoint), opened from its pin or its card. It lives in one thread of its own and
opens full screen (ADR 0053).
_Avoid_: service, entrypoint (for the App)

**Pin**:
A server or one App view the owner keeps in the sidebar's Pinned list, in their order, on every device. A connected
server with its own App is pinned until the owner unpins it. Pinning grants nothing.
_Avoid_: favourite, bookmark

**Agent app**:
A small program the agent wrote and goblin runs (ADR 0021): durable state, actions and views the agent calls with
`app_call`, and its own files. Not an MCP App, which a server serves.

**Release**:
One build of an agent app. One is active; earlier ones can be rolled back to, and failed ones keep their problems.

**Revision**:
The number of an agent app's state, one more with every change an action commits.

**Power**:
Something an agent app reaches beyond its state and files (a host, an MCP tool, the model, a message to the owner
through Notify me via, another app); it declares it, and the owner approves it.

**Schedule**:
An agent app's action that runs on its own, every 15 minutes to daily.
_Avoid_: cron job

**Block**:
A fenced `mermaid`, `chart` or `map` block in the agent's reply, drawn in place (ADR 0023).

**Kit**:
`@goblin/kit`, the one implementation of the drawn blocks, for the chat and agent apps.

**Files**:
The owner's files (ADR 0022): `/uploads`, what they uploaded or attached, and `/agent`, what the agent wrote. The
agent writes only `/agent`.

**Attachment**:
A file the owner sent with a message: its path rides with the words, and the message shows it.

**Received file**:
A file goblin kept from an MCP tool result (ADR 0065): a link, an embedded resource or audio, written under
`/agent/received/<connection>/<day>/`. The model reads its path in the block's place, and the call shows it as a chip.

**File link**:
A short-lived https URL on goblin's own origin to one of the owner's files (`file_link`, ADR 0070), for a tool that
takes a file by URL: it works for fifteen minutes and serves only that file. Sending it is the receiving tool's call.
_Avoid_: share link, public link

## Goblin Wallet

**Goblin Wallet**:
A wallet with its own MCP server and web app, a product of its own outside this repository (ADR 0056). goblin connects
it like any other MCP server (ADR 0063).
_Avoid_: agentic wallet (the earlier working name), treasury

**Wallet limit**:
A limit the wallet itself keeps for a connection: per call, per hour, per week, with an expiry, plus the allowed paid
services and the address book. goblin keeps no limit of its own beside it; Ask first is the owner's control in goblin.
_Avoid_: budget, cap (alone)

## The agent's API and records

**Owner API**:
The typed API the owner's browser calls under `/api`: admitted at the Worker's edge, then served by the owner's own
agent (ADR 0038).
_Avoid_: RPC

**Account API**:
What the Worker answers without waking an agent: inbound clients and browser crash reports.

**Internal API**:
The typed API through which the Worker reaches an agent for anyone but the owner's browser: an inbound client's ask
and reads, inspection, and the hooks. The browser can never reach it.

**Workspace feed**:
One stream per tab of what the workspace shows: every chat and its activity, the Apps, Topics, Personas and receipts.
The web keeps it in its query cache.

**Operation ID**:
The stable key that makes a submission idempotent: a retry with the same one finds the same result. Acceptance is
not external completion.

**Receipt**:
The record of one operation in a chat: what it was, who started it, the chat it made, the operation that led to it,
and how it ended. It proves admission, never completion.

**Flow**:
One content-free step of how people and agents move through conversations (a send, a thread started, a move, a
Persona's answer, a routine firing), recorded with its operation (ADR 0037).

**Reference**:
The short id a failure shows the owner (`… · ref 7f3a9c12`), which finds that request's log lines (`goblin lookup`).
_Avoid_: error id, trace id

**SingleFlight**:
The agent's one run per key across waits: a caller asking for work already running under that key joins it, or skips
it, and the work outlives the caller that started it.
_Avoid_: lock (`KeyedLock` admits one holder per key and is never held across a wait)

**Pi Durable / PiHarness**:
The conversation and execution runtime. It owns transcripts, tasks, recovery and tool replay; `PiHarness` is its
native Agents SDK adapter.

## Access and deployment

**Sign-in method**:
A way into an account (ADR 0064): an emailed code, or the deployment's identity provider (OpenID Connect, its button
labelled by the deployment). `/health` lists the ones a deployment offers; it needs at least one.
_Avoid_: login provider, SSO

**Identity provider**:
The deployment's OpenID Connect provider (`GOBLIN_OIDC_*`), such as mysi or a company's IdP: one more way to sign in,
under the same sign-up mode. goblin keeps none of its tokens. Not to be confused with goblin's own OAuth provider, which
signs in MCP clients to `/mcp`.

**Sign-up mode**:
`open`, `invite` (an invite code is required) or `closed`: who gets an account, by either sign-in method. Every account
reaches its own agent and everything in it (ADR 0058).

**Daily usage**:
The model tokens an account's agent spent in the current UTC day, input, output and cached alike (ADR 0058).
_Avoid_: Credits

**Daily token cap**:
The deployment's optional limit on an account's daily usage (`GOBLIN_DAILY_TOKEN_CAP`). Once a capped day is spent, new
turns, routine runs, housekeeping and tools inside a running turn are refused until 00:00 UTC; unset, nothing is.
_Avoid_: allowance

**Stage**:
One deployment: `local`, `dev`, `prod` or a disposable `test_*` environment, each with its own resources and secrets.
At runtime the stage is a label only (mail subjects, robots, telemetry tags); what a deployment does comes from its
configuration (ADR 0064).

**Optional feature**:
A part a deployment may go without, each a binding of its own: large files (an R2 bucket), agent apps (Dynamic
Workers) and flow metrics (Analytics Engine). `/health` lists which it has (`features`).

**CLIProxy / LiteLLM**:
The model gateways: CLIProxy for local work on the build box, Railway LiteLLM for deployed stages, each with its own
capped key.

**Alchemy**:
The only infrastructure and local-workerd entrypoint.
