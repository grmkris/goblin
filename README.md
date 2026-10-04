# Purrable

Resident personal agents on Cloudflare. Each user signs up and gets their own agent: they talk to it in the browser,
it keeps running, holds its own authority to use the MCP servers that user connected, and is itself an MCP server
other tools can talk to.

Built on the Cloudflare Agents SDK (`PersonalAgent` Durable Object) with the native Pi harness (Pi Durable owns
conversations and execution), Effect at service seams, Better Auth for identity, and Alchemy for infrastructure.

```sh
bun install --frozen-lockfile
mkdir -p .local && cp .env.example .local/local.env && chmod 600 .local/local.env
bun dev            # http://localhost:18971, models through CLIProxy
bun run check      # the full gate (run it through `heavy` on the build box)
```

- [Architecture](docs/architecture.md): how the Worker, the agent object, Pi, MCP and auth fit together.
- [Development](docs/development.md): local setup, the dev stage, connecting servers, adding Purrable to Claude Code.
- [Next](docs/next.md): the seams for routines and write approvals.
- [Decisions](docs/adr/): why it is shaped this way. [Glossary](GLOSSARY.md).

The dev stage (`purrable-dev`) is the daily instance. Its sign-up is closed: existing accounts sign in, nobody new can
register. There is no production stage yet.
