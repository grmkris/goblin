# ADR 0092: MCP calls are checked against their schema and keep the server's message

Status: Accepted 2026-10-21.

Personas and owner turns call remote MCP tools through `mcp_call`, and small models often get the arguments wrong: a
missing nested field, a number for a string, a field the tool does not take. goblin sent such a call as it was, and
the model read whatever came back. When the server answered a JSON-RPC error, goblin kept only its code, so the model
read `UpstreamMcp (connectionId: x, reason: remote-rpc, code: -32602)` and could not tell what to fix. The server had
said, but its message was dropped with the rest of the remote payload.

## Decision

- **Arguments are checked before they are sent.** `callTool` (`mcp/connections/manager.ts`) checks a call's arguments,
  as they would be sent, against the tool's input schema as listed, after the tool is found and before anything goes
  out. One place covers the model's calls, approved held calls, URL request retries, Apps and goblin's own calls. The
  check is the MCP SDK's Workers-safe validator (`CfWorkerJsonSchemaValidator`), set to report every problem.
- **A call that does not fit is refused with every problem.** It fails `InvalidArguments` (`connectionId`, `name`,
  `problems`), a new failure in the contract's vocabulary: 400 `invalid_arguments` on the API, with the problems as a
  safe field. Each problem is `<pointer>: <problem>` on one line of at most 200 characters, control characters
  dropped, at most twelve; the validator's summaries ("Property "step" does not match schema.") are left out, since
  what they sum up follows. `mcp_call` gives the model all of them: "The arguments do not match `<tool>`'s input
  schema; fix them and call again:" and one line each.
- **A schema goblin cannot read does not block the call.** One the validator cannot compile (another dialect, a
  duplicate `$id`), or a check it cannot finish, lets the call go unchecked, as before, and is never a defect. Each
  compiled check is kept with the schema object it came from (`Manager.argumentChecks`), so a new listing compiles anew.
- **A server's JSON-RPC error keeps its message.** `mapMcpError` keeps the error's code and, as `serverMessage`, its
  message and its `data` when that is text, nothing else of `data`, on one line of at most 500 characters, control
  characters dropped. `describeError` shows it whole after the failure, quoted as the server's:
  `… code: -32602): the server says: "…"`.
- **Content stays out of telemetry, logs and the envelope.** Telemetry records `invalid_arguments` or
  `UpstreamMcp:remote-rpc` and nothing of the problems or the server's words (ADR 0024). The API's envelope never
  carries `serverMessage`, so a caller, a server's key over `/mcp` included, never reads another server's words.

## Consequences

- A small model learns what was wrong in one result and fixes all of it in one more call, and a malformed call never
  reaches the server, so it cannot half-run there.
- goblin now refuses calls a lenient server would have taken: a tool whose schema is stricter than its server (a field
  marked required that it does not need) fails until the server fixes its schema. `format` is not checked: JSON Schema
  2020-12 makes it an annotation, and a server may not check it either.
- A held ask-first call is still held before it is checked, so the owner may approve a call that then fails its check;
  nothing is sent, and the turn reads that it failed before it was sent.
- The model reads remote text in a failure as well as in a result. It stays untrusted data, bounded and on one line.
