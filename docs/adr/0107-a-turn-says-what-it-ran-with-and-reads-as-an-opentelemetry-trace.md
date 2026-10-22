# ADR 0107: A turn says what it ran with, and reads as an OpenTelemetry trace

Status: Accepted 2026-10-22 with the owner. Amends ADR 0024 (what a run event carries, and inspection answers a turn
as an OpenTelemetry trace) and ADR 0084 (a key's `inspect_turn` can answer that trace, within its reach, and a turn's
steps say what each ran with).

## Context

The main conversation never ends (ADR 0007), so its turns run across changes the run ledger did not record: the code
(every green push to `dev` deploys, and for up to ten minutes after a deploy the agent answers from the old code while
the edge already runs the new one), the model endpoint (the deployment's, or the owner's own, ADR 0059), the thinking
level (ADRs 0083 and 0100), the prompt and the tools (Topics, Personas, a fork's native MCP tools, ADR 0101) and the
remote MCP servers themselves. "It worked yesterday" could not be answered from the ledger. And what the ledger did
record about the endpoint was misleading: every model call named the provider `goblin-litellm` (a routine run's
`goblin-routine:rr_*`, a run id), and the model the owner asked for was replaced by the one the endpoint served.

A turn could be read as content-free steps (`inspect_turn`) and as words (`inspect_conversation`), but nothing joined
them, the CLI and the Details panel did not draw the steps, and no tool outside goblin could open a turn. Building our
own timeline format and viewer (as Parcha's agentrun does) would be one more thing to keep. OpenTelemetry's GenAI and
MCP semantic conventions (now in `open-telemetry/semantic-conventions-genai`) already describe an agent's run as a
trace, and the run events were modelled on them from the start.

## Decision

**Each run event says what it ran with, by the conventions' names where they have one.** Names and counts only, never
content (ADR 0024):

- every event: `gen_ai.agent.version`, the release's commit (`VITE_GOBLIN_BUILD`, absent on the local stack);
- a model call (`model.attempt`, `model.aux`): `gen_ai.provider.name` `openai`, the flavour of the API every endpoint
  speaks; `gen_ai.request.model` the model asked for and `gen_ai.response.model` the one that answered;
  `goblin.model.endpoint`, `deployment`, `owner` or `none`; for the deployment's endpoint only, its `server.address`
  and `server.port`; and `gen_ai.request.reasoning.level`, the thinking level goblin asked Pi for. That level is Pi's
  name for it, which Pi maps per model to the provider's own parameter (ADR 0083), not the exact value sent as the
  convention would have it;
- a model attempt after the prompt or the tools changed (Pi records each change as a `pi.system` entry before that
  attempt): `goblin.prompt.sections`, the keys of the sections that changed; `goblin.prompt.baseline` when it was a
  restatement after compaction rather than a change; `goblin.tools.added` and `goblin.tools.removed`, counts; and
  `goblin.tools.changed`, the names of at most eight changed tools. Never a section's text or a tool's schema;
- an MCP request: `mcp.method.name` (replacing `goblin.mcp.method`), `mcp.protocol.version`, the server's own name and
  version as its `initialize` reported them (`goblin.mcp.server.name`, `goblin.mcp.server.version`) and the
  fingerprint of its tool list (`goblin.mcp.tools_digest`). Never the server's address;
- cached input written is `gen_ai.usage.cache_write.input_tokens`, the conventions' current name.

**The operator's endpoint stays the operator's.** `server.address` and `server.port` reach the deployment's own
Workers Logs and traces, and every inspection read leaves them out, the owner's included: the host is the operator's
model gateway, and a workspace owner, or a server holding their key, reads which kind of endpoint answered, never where
it is. The owner's own endpoint is recorded by kind only, so its address never reaches the operator either.

**A turn reads as an OpenTelemetry trace.** `inspect_turn` (`GET /api/inspect/turn?operation=&format=otlp`, and the
tool's `otlp` switch) answers the turn as OTLP/JSON traces data: the root span `invoke_agent goblin` (internal), a
`chat {model}` span (client) for each model attempt, an `execute_tool {tool}` span for each tool call with the
`{mcp.method.name} {tool}` span (client) of the MCP request it made inside it, and a `compaction` span; the turns it
started (a Persona's answer, a thread's first send) nest under it, at most twenty. Its resource names the service
`goblin`, its version and its `deployment.environment.name`. Ids are derived from the workspace and the operation, so
the same turn is the same trace every time it is read. The shapes are Effect's own OTLP types and resource helper; the
trace carries what the turn's run events carry, so no content and nothing outside the caller's reach: a key reads the
trace of a turn in its reach, as it reads the turn.

**Words are added on the reader's machine.** The `goblin` CLI's `turn <operation> --otlp` asks for the trace and, when
its client may read conversations, fills the conventions' opt-in content attributes from `inspect_conversation`: a
model call's `gen_ai.output.messages`, a tool call's `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`, and
the turn's `gen_ai.input.messages` and `gen_ai.output.messages`. The filled trace is posted to any OTLP viewer on the
developer's own machine. goblin builds no timeline viewer of its own.

**A turn's steps and Details say it too.** Each step of a turn's timeline gains what it ran with (version, endpoint,
thinking level, prompt and tool changes, and the MCP server's name and version), and the timeline a summary of it
(`ranWith`); the CLI prints both, and the Details panel draws the steps as a timeline with a "Ran with" line.

## Consequences

- Which code a turn ran on is a field: a turn right after a deploy shows the old commit, and the turn after the agent's
  restart the new one.
- A run event carries more attributes. Within the bound of 2048 characters per event, the drift attributes are capped
  (sixteen section keys, eight tool names) so tokens and the finish reason are never the ones dropped.
- `pi.system` entries and their `edits` are Pi Durable's internal shape (1.3.0), decoded defensively; a change there
  shows as missing prompt attributes, never as a failed turn.
- The conventions are in development; a renamed attribute is a renamed constant.
- A long Persona job can make a large trace; it is bounded at twenty child turns and 2,000 spans, and the tool's
  description steers model clients away from asking for it.

## Rejected

- **Our own timeline rows and viewer** (agentrun's `@parcha/pi-durable-agent/timeline` and replay pages): one more
  format to keep when the conventions already describe the run, and viewers already read them.
- **A semantic-conventions or OpenTelemetry SDK dependency**: goblin keeps its attribute names as constants, and Effect
  already ships the OTLP shapes.
- **A hash of the system prompt or tool set**: it is derived from content, and the section keys and tool names say
  what changed.
- **The address of the owner's endpoint or of an MCP server**: the owner's configuration is not the operator's to read.
- **A separate `inspect_trace` tool**: one tool per endpoint; the trace is a format of the same turn.
- **Exporting traces from the Worker to a collector**: it needs a collector and a credential per deployment;
  Cloudflare's own tracing is the platform's path, and a trace read on demand serves debugging.
- **The Cloudflare version id (`CF_VERSION_METADATA`, `faas.version`)**: the commit says which code ran; a redeploy
  of the same commit changes the configuration, which the endpoint and model fields already show.
