# Purrable

Resident personal agents on Cloudflare. Each user signs up and gets their own agent: they talk to it in the browser,
it keeps running, holds its own authority to use the MCP servers that user connected, and is itself an MCP server
other tools can talk to.

The agent has one main conversation. Side threads can start empty or branch from a main message; they can share a note
back to main and can be archived, and main learns the name of one started empty. Each conversation can switch off,
for its own agent, connections and their tools, skills libraries and subagents; a new thread starts with main's
switches. Background subagents work in their own conversations and report back to the conversation that started them. Main keeps an OptChat-style memory view: summaries of older messages followed by the
newest exchange verbatim.

Telegram comes through a myagent MCP connection. The owner turns on **Use for Telegram** for one server in Connections;
myagent rings a doorbell, Purrable pulls the inbox into main, and answers go back with `send_message`. Skills are read
from MCP servers the owner enables for skills, and the agent can propose skill drafts for the owner to review.

The browser also hosts one sandboxed MCP App at a time. Owners can add public servers by URL or from MCP registries,
grant tools explicitly, choose an offered model, and see the per-account daily token budget. The agent uses `ask_user`
to ask questions the owner answers in their next message.

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
- [Next](docs/next.md): the seams for routines and write approvals.
- [Memory benchmarks](bench/README.md): isolated native Pi experiments, GLM/DeepSeek variants, bounded accounting and local reports.
- [Decisions](docs/adr/): why it is shaped this way. [Glossary](GLOSSARY.md).

The deployment stages are `dev` at `dev.purrable.lol` and `prod` at `purrable.lol`, with separate auth databases,
secrets and dedicated LiteLLM keys. Alchemy can attach the custom domains; deployment and live acceptance are operator
steps. Alternate hosts redirect to the configured canonical origin. Dev sign-up stays closed or invite-only; prod
supports open sign-up only with verified mail sending. Both stages use `hello@purrable.lol` after sender onboarding,
with a host prefix on dev mail subjects. See [development](docs/development.md) for the production guard and smoke.
