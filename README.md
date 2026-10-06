# goblin

Your own goblin, always on. Resident personal agents on Cloudflare. Each user signs up, subscribes to Pro ($10/month), and gets their own agent: they talk to it in the browser,
it keeps running, holds its own authority to use the MCP servers that user connected, and is itself an MCP server
other tools can talk to.

The agent has one main conversation. Side threads can start empty or branch from any message of any conversation, at
any depth; they can share a note back to where they came from, and Close stops one with everything under it until it is
reopened. Main learns the name of a thread started empty, and one live feed keeps every open tab's list and activity
current. A thread unfolds in place under the
message it branched from, live and at any depth, with its own composer, until it is opened in a pane. Each conversation can switch off,
for its own agent, connections and their tools, skills libraries and subagents; a new thread starts with main's
switches. Background subagents work in their own conversations, start their own when a job splits, report their final
answer back to the conversation that started them and close when done; the owner can write to one to steer it. Main keeps an OptChat-style memory view: summaries of older messages followed by the
newest exchange verbatim.

Tool calls expand in place to readable input and output, with folding JSON branches, formatted Markdown, full-value
copying and a Raw view.
The agent's replies draw Mermaid diagrams, charts, maps and compact mdxcn figures from fenced blocks, in the theme's colours.

Telegram comes through a mygram MCP connection. The owner turns on a server's **Telegram** switch in Connections; signed
MCP Events wake an authoritative inbox pull into main, and replies go back with `send_message`. Older servers use
the doorbell fallback until cut-over. Owner-enabled skills libraries use update Events to invalidate their cached
catalog; the next activation refetches, while retained activations keep their verified version.

Every conversation (main, a thread, a subagent) and every kept MCP App is a pane of its own: open beside, drag to
split or swap, resize, close any but the last. Apps also run in place in any conversation, several at once, and move
to their page and back without reloading. The URL names the focused conversation or App and the device remembers the
arrangement; narrow screens show one pane at a time in a swipeable strip. Owners can add public servers by URL or from MCP registries,
grant tools explicitly, choose an offered model, and see the per-account daily budget in Credits. The agent uses `ask_user`
to ask questions the owner answers in their next message. The owner attaches files to a message with the composer's
paperclip; the agent reads them and writes its own results beside them, kept per agent in SQLite and R2.

The agent builds apps for its owner from ordinary conversation (ADR 0021): small programs goblin runs in Cloudflare
Dynamic Workers, with durable state, actions and views that become the agent's tools, an optional live UI drawn with
goblin's components, charts, maps, diagrams and mdxcn figures, schedules that run on their own, and powers (the web,
the owner's MCP tools, a cheap model, Telegram, other apps) that each wait for the owner's Allow. The Apps page lists them; an app can
fill the workspace with its conversation docked beside it, roll back to an earlier version, or be deleted.

Every turn can be seen end to end (ADR 0024). Beside Pi's own record, each agent keeps a 30-day run ledger of how its
turns ran: model attempts, tool calls, retries, MCP steps, Telegram replies, timings, tokens and errors, never content.
Workers Logs and Traces carry the same ids. A coding agent reads the owner's conversations and any turn's timeline
through the read-only inspection tools of goblin's one MCP endpoint, `/mcp` (when the owner grants `goblin:inspect`), or
the `goblin` CLI (`apps/cli`), and the agent answers "why did that fail?" with its own `diagnose` tool.

Workspace layout uses [Trellis 0.3.0 by Dan Fessler](https://github.com/DanFessler/trellis), under its commercial
license and goblin-specific permission: goblin may use it without sponsorship until it makes money, in exchange
for crediting Dan and allowing him to showcase goblin as a Trellis user. When revenue starts, Kris maintains the
applicable active GitHub Sponsorship: $10/month for individuals, $100/month for studios of up to 10 members;
larger organizations require an enterprise agreement. The sidebar footer also links Dan's credit. See
[ADR 0016](docs/adr/0016-workspace-layout-with-trellis.md) and [ADR 0019](docs/adr/0019-panes-for-everything.md).

Built on the Cloudflare Agents SDK (`PersonalAgent` Durable Object) with the native Pi harness (Pi Durable owns
conversations and execution), Effect at service seams, Better Auth for identity, and Alchemy for infrastructure.

```sh
bun install --frozen-lockfile
mkdir -p .local && cp .env.example .local/local.env && chmod 600 .local/local.env
bun dev            # http://localhost:18971, models through CLIProxy
bun run check      # the full gate (run it through `heavy` on the build box)
```

- [Architecture](docs/architecture.md): how the Worker, the agent object, Pi, MCP and auth fit together, including
  conversations, memory, skills, Telegram and MCP Apps.
- [Development](docs/development.md): local setup, the dev stage, connecting servers, adding goblin to Claude Code.
- [Next](docs/next.md): remaining acceptance and write approvals.
- [Memory benchmarks](bench/README.md): real Claude/Hermes recall campaigns, persistent checkpoints, shared CLIProxy budgets and blinded review.
- [Decisions](docs/adr/): why it is shaped this way. [Glossary](GLOSSARY.md).

The deployment stages are `dev` at `dev.goblin.surf` and `prod` at `goblin.surf`, with separate auth databases,
secrets and dedicated LiteLLM keys. Alchemy can attach the custom domains; deployment and live acceptance are operator
steps. Alternate hosts redirect to the configured canonical origin. Dev sign-up stays closed or invite-only; prod
supports open sign-up after sender verification. Email OTP is the sole login method, and every stage requires mail. Both stages use `hello@goblin.surf` after sender onboarding,
with a host prefix on dev mail subjects. See [development](docs/development.md) for the production guard and smoke.

Pro has no free tier or trial and includes 800 model Credits (about 2 million tokens) per account per UTC day. Dodo checkout grants
nothing until its signed webhook activates the account. Cancellation keeps access through the paid period, and failed
renewals have bounded grace. Settings provides the billing portal; `/subscribe` handles unpaid accounts. Draft terms,
privacy and refund pages await operator review before live payments. Native workerd tests use real D1 and an injected
Dodo client; real Dodo checkout, keys and merchant acceptance remain operator steps.

Routine proposals are reviewed in Settings → Routines. The owner confirms the exact prompt, trigger, timezone, tool
pairs, budgets and Telegram policy. Confirmed reminders, cron schedules and MCP Events run in isolated threads and post a short
passive note to main. Run now, Stop, Pause, Edit and Archive are available; Telegram reports require an explicit
notification choice. Event confirmation authorizes the exact connected server, event name and JSON filters; controls never start a model turn. See [the routines decision](docs/adr/0012-routines.md).

LOCAL throwaway-account acceptance covers routine reminders, cron recovery across a process restart, revoked-authority skips and caps through CLIProxy. Native alarm tests also verify recurring recovery wakes; real producer Events and deployed acceptance remain separate.

Main has Home below its latest exchange: figure snapshots, recent conversations, agent apps and owner-pinned MCP Apps. Ask for a tile, such as a reading tracker or inbox; Edit Home changes shared order and size, and agent edits leave Show and Undo receipts. Placement grants nothing. See [ADR 0025](docs/adr/0025-home-surface.md).
