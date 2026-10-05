# Purrable

Resident personal agents on Cloudflare. Each user signs up, subscribes to Pro ($10/month), and gets their own agent: they talk to it in the browser,
it keeps running, holds its own authority to use the MCP servers that user connected, and is itself an MCP server
other tools can talk to.

The agent has one main conversation. Side threads can start empty or branch from any message of any conversation, at
any depth; they can share a note back to where they came from, and Close stops one with everything under it until it is
reopened. Main learns the name of a thread started empty, and one live feed keeps every open tab's list and activity
current. A thread unfolds in place under the
message it branched from, live and at any depth, with its own composer, until it is opened in a pane. Each conversation can switch off,
for its own agent, connections and their tools, skills libraries and subagents; a new thread starts with main's
switches. Background subagents work in their own conversations and report back to the conversation that started them. Main keeps an OptChat-style memory view: summaries of older messages followed by the
newest exchange verbatim.

Telegram comes through a mygram MCP connection. The owner turns on **Use for Telegram** in Connections; signed
MCP Events wake an authoritative inbox pull into main, and replies go back with `send_message`. Older servers use
the doorbell fallback until cut-over. Owner-enabled skills libraries use update Events to invalidate their cached
catalog; the next activation refetches, while retained activations keep their verified version.

Every conversation (main, a thread, a subagent) and the sandboxed MCP App is a pane of its own: open beside, drag to
split or swap, resize, close any but the last. The URL names the focused conversation and the device remembers the
arrangement; narrow screens show one pane at a time in a swipeable strip. Owners can add public servers by URL or from MCP registries,
grant tools explicitly, choose an offered model, and see the per-account daily token budget. The agent uses `ask_user`
to ask questions the owner answers in their next message.

Workspace layout uses [Trellis 0.3.0 by Dan Fessler](https://github.com/DanFessler/trellis), under its commercial
license and Purrable-specific permission: Purrable may use it without sponsorship until it makes money, in exchange
for crediting Dan and allowing him to showcase Purrable as a Trellis user. When revenue starts, Kris maintains the
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
- [Development](docs/development.md): local setup, the dev stage, connecting servers, adding Purrable to Claude Code.
- [Next](docs/next.md): remaining acceptance and write approvals.
- [Memory benchmarks](bench/README.md): isolated native Pi experiments, GLM/DeepSeek variants, bounded accounting and local reports.
- [Decisions](docs/adr/): why it is shaped this way. [Glossary](GLOSSARY.md).

The deployment stages are `dev` at `dev.purrable.lol` and `prod` at `purrable.lol`, with separate auth databases,
secrets and dedicated LiteLLM keys. Alchemy can attach the custom domains; deployment and live acceptance are operator
steps. Alternate hosts redirect to the configured canonical origin. Dev sign-up stays closed or invite-only; prod
supports open sign-up only with verified mail sending. Both stages use `hello@purrable.lol` after sender onboarding,
with a host prefix on dev mail subjects. See [development](docs/development.md) for the production guard and smoke.

Pro has no free tier or trial and includes 2 million weighted tokens per account per UTC day. Dodo checkout grants
nothing until its signed webhook activates the account. Cancellation keeps access through the paid period, and failed
renewals have bounded grace. Settings provides the billing portal; `/subscribe` handles unpaid accounts. Draft terms,
privacy and refund pages await operator review before live payments. Native workerd tests use real D1 and an injected
Dodo client; real Dodo checkout, keys and merchant acceptance remain operator steps.

Account workspaces are selected server-side from verified D1 membership. Existing personal agents keep their owner
ID and history. Members each need their own Pro plan; the owner reads all workspace conversations. Shared Agent
access uses principal-bound contexts, live member scope and the acting account's allowance. Email
invitations carry a link and invitation code; accepting requires the addressed email and an active plan. Settings
provides workspace selection, empty permission checkboxes, member/viewer invitations and leave/remove controls.
Workspace access is read live on every request; expired admission and rate-limit data is cleaned up hourly. See
[ADR 0014](docs/adr/0014-members-and-workspace-authority.md).

Routine proposals are reviewed in Settings → Routines. The owner confirms the exact prompt, trigger, timezone, tool
pairs, budgets and Telegram policy. Confirmed reminders, cron schedules and MCP Events run in isolated threads and post a short
passive note to main. Run now, Stop, Pause, Edit and Archive are available; Telegram reports require an explicit
notification choice. Event confirmation authorizes the exact connected server, event name and JSON filters; controls never start a model turn. See [the routines decision](docs/adr/0012-routines.md).

LOCAL throwaway-account acceptance covers routine reminders, cron recovery across a process restart, revoked-authority skips and caps through CLIProxy. Native alarm tests also verify recurring recovery wakes; real producer Events and deployed acceptance remain separate.

The Members Phase B release includes isolated member contexts, scoped execution, designated question/approval
receipts, filtered reads and account-wide usage attribution. Deployed Workers opt in through the reviewed Alchemy
binding; the native fixture also tests the closed default. Invitation-created accounts still do not provision their
own personal Agent while that product decision is pending.
Named readers are bound to current membership versions. Questions use the questionnaire and only their designated
answerer can settle them; viewers can send an access request without starting a model turn. Removal queues durable
invalidation retries, and late cleanup preserves questions belonging to newer membership versions.
