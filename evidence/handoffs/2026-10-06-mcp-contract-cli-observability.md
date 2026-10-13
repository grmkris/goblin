# Goblin MCP, API, CLI, and observability handoff

Date: 2026-10-06

Status: research artifact for review. No application implementation or provider mutation was performed for this handoff.

Repository: the `purrable` checkout on the dev box, product name `goblin`, branch `main`. HEAD observed while preparing this file: `71454fa53db15da5abc9107b0daafde36f75fd55`. The shared checkout has concurrent uncommitted application edits; this is a source snapshot, not an assertion that every observation belongs to that commit or is deployed.

Reviewer: please validate the protocol claims against the current installed declarations and the latest official MCP documents before implementation. Treat sections labelled **Proposed** as design material, not as shipped behavior.

Suggested instruction to the reviewing agent: review this design read-only, check the primary sources and current code, identify incorrect claims or unnecessary complexity, and return the smallest viable architecture plus the remaining decisions. This handoff does not authorize implementation, deployment, connecting accounts, model spend, or changes to external systems.

## 1. Review question

Goblin needs a simple way for a coding agent to inspect the product: conversations, threads, subagents, Pi tasks, submissions, recovery, MCP activity, model calls, logs, and traces. The desired operator experience is one MCP connection that a coding agent can query, rather than manually navigating several Cloudflare dashboards or giving the agent broad Durable Object/Data Studio access.

The user explicitly wants shared schemas, a generated CLI, a native MCP endpoint that does not wrap the CLI, both outbound MCP consumption and inbound publication, and minimal operational complexity. Exact operation names, scope design, framework choices, and rollout order below are **Proposed**.

The proposed shape is contract-first:

```text
Effect schemas and domain services
        ├── HTTP API + OpenAPI
        ├── typed client + goblin CLI
        └── native MCP endpoint
                ├── tools
                ├── resources/templates
                ├── prompts (only where useful)
                ├── Tasks for long work
                ├── MCP Apps for interactive views
                └── subscriptions/listen for protocol changes
```

The MCP endpoint must call the same application services as HTTP and the CLI. It should not invoke the CLI as a subprocess, and the CLI should not contain a second implementation of the business logic.

## 2. Current Goblin facts verified in the repository

- `PersonalAgent` is a native Agents SDK Durable Object. Pi owns transcripts, tasks, submissions, recovery, and tool replay. Drizzle owns application tables with the `app_` prefix. Vendor tables such as `pi_*` and `cf_agents_*` are intentionally opaque. See [docs/architecture.md](../../docs/architecture.md) and [apps/runtime/src/storage/vendor.ts](../../apps/runtime/src/storage/vendor.ts).
- The existing owner API already reads Pi through supported paths: snapshots, committed events, paginated history, workspace activity, and conversation registry operations. See [apps/runtime/src/agent-requests.ts](../../apps/runtime/src/agent-requests.ts) and the route inventory in [docs/architecture.md](../../docs/architecture.md).
- The current inbound MCP endpoint is `/mcp`, protected by Better Auth OAuth. A consented client is bound to the subject user's agent. The current server exposes only `ask_agent` and `get_recent_messages`. See [apps/runtime/src/inbound/server.ts](../../apps/runtime/src/inbound/server.ts) and [apps/runtime/src/inbound/route.ts](../../apps/runtime/src/inbound/route.ts). Clients currently talk in main; the earlier per-client-session wording in ADR 0003 is historical and was superseded by ADR 0007.
- The current outbound MCP host uses the official client package, Streamable HTTP, automatic protocol negotiation, bounded discovery, authorization, resource templates, prompts, and a Goblin Skills extension. See [apps/runtime/src/mcp/connection.ts](../../apps/runtime/src/mcp/connection.ts).
- The repository currently pins `@modelcontextprotocol/client` and `@modelcontextprotocol/server` `2.2.0`, `@modelcontextprotocol/ext-apps` `2.0.3`, `agents` `0.26.0`, and `effect` `4.0.0`. The current package versions are already in the MCP SDK v2 line.
- Goblin already consumes MCP Apps from outbound servers in a sandboxed host. It does not yet publish a Goblin-owned MCP App from its inbound server.
- Goblin has an outbound draft MCP Events profile for event subscriptions. This is distinct from the released core `subscriptions/listen` mechanism and from the experimental MCP Triggers & Events working group.
- Effect services are composed in a long-lived `ManagedRuntime` per agent object. There is no complete Effect-to-Cloudflare tracing/export layer wired into the runtime today.

Useful source entry points beyond the route inventory: [packages/contracts/package.json](../../packages/contracts/package.json), [apps/runtime/package.json](../../apps/runtime/package.json), [apps/web/package.json](../../apps/web/package.json), [apps/runtime/src/compose.ts](../../apps/runtime/src/compose.ts), [apps/runtime/src/workspace/feed.ts](../../apps/runtime/src/workspace/feed.ts), [apps/runtime/src/pi/transcript.ts](../../apps/runtime/src/pi/transcript.ts), and [apps/runtime/src/mcp/events/protocol.ts](../../apps/runtime/src/mcp/events/protocol.ts). The convenience `transcriptMessages` projection deliberately omits tool traffic and system entries; it is not a full-fidelity inspection API.

## 3. Observability boundary

Cloudflare is useful for platform execution data, but it is not the conversation system of record.

| Surface | Correct responsibility |
| --- | --- |
| Pi / Agent Durable Object | Complete conversation, tool traffic, tasks, submissions, and recovery |
| `app_*` SQLite tables | Goblin-owned metadata, registries, grants, projections, and product state |
| Workers Logs | Structured request/application events, exceptions, timings, and correlation fields |
| Workers Traces | Fetch, Durable Object, RPC, storage, alarms, and custom span timing |
| Log Explorer | Search and analyze retained raw log data where the account plan supports it |
| Basin | Long-term normalized product and operational event analytics |
| Agent-facing inspector | One joined, machine-readable result for the coding agent |

Cloudflare Durable Objects Data Studio can query an individual deployed SQLite-backed object, but it is a dashboard editor with write capability, requires Worker Editor access, operates on one object identifier at a time, and is billed as live object usage. It is suitable for exceptional operator investigation, not as the regular coding-agent interface. It must not be used to read Pi/vendor tables as if they were a stable public schema.

There is no documented native SQL join between Data Studio SQLite and Workers Logs/Traces. A unified inspector must either federate the sources or query a normalized event index. Pi remains authoritative for full content; logs and an analytics index should carry stable references such as `runId`, `conversationId`, `taskId`, `entryId`, `requestId`, trigger, attempt, and release.

The first useful MCP tools are therefore high-level and read-oriented:

```text
observe_search
observe_run
observe_conversation
observe_task
observe_logs
```

They should return bounded structured JSON, source/freshness/completeness markers, and references to deeper records. They should not accept arbitrary SQL or expose raw vendor table names.

Persisted records show what was stored. They cannot automatically explain a failed call before persistence or reconstruct the exact historical provider request if its final assembled input was never captured. A federated result is also not one transactionally consistent snapshot across Pi, logs, and an asynchronously ingested index. Return per-source timestamps, cursors, and explicit gaps.

No live Cloudflare settings were refreshed for this handoff. Earlier in this conversation, `goblin-dev` had persisted invocation logs at sampling `1`, traces disabled, no Logpush, and no tail consumers. That earlier readback and the then-observed absence of `goblin-prod` may already be stale after concurrent deployment work. Recheck the intended stage before using any of those facts operationally. Sources do not establish Goblin's current Log Explorer or Basin entitlements.

## 4. Canonical contracts and generated surfaces

**Proposed:** define stable boundary schemas in `@goblin/contracts` with Effect Schema. Keep the schema about product operations and records, not about the internal SQLite schema.

**Proposed:** evaluate Effect 4 `HttpApi` for the new endpoint declarations. One declaration can provide runtime request/response validation, HTTP handlers, OpenAPI 3.1 output, URL construction, and typed client signatures. `@effect/openapi-generator` can generate a client from OpenAPI when a separate generated artifact is useful. `effect/cli` can provide the CLI command tree. These capabilities do not establish a complete automatic OpenAPI-to-CLI or OpenAPI-to-MCP generator.

Keep only portable schemas/types in the existing contracts package, following its AGENTS.md. The reviewer should choose where HTTP contract declarations and CLI/MCP exposure metadata live without pulling runtime, Cloudflare, or Node dependencies into that package. Schemas alone do not describe paths, operation IDs, auth, errors, CLI flags, or App/event behavior.

The generated CLI should derive command registration, argument validation, and typed calls from the shared contract plus a small amount of CLI metadata. Help text, pagination, file inputs, `--json`, and `--follow` need explicit design. Avoid building a general code-generation framework for the first few reads. These command examples are illustrative and do not exist yet:

```text
goblin conversations
goblin conversation <id> [--history]
goblin observe search --run <runId>
goblin observe run <runId> --include conversation,tasks,traces
```

OpenAPI-to-MCP generation can scaffold code, but should not be the production design. MCP tools need model-oriented names, descriptions, read/write annotations, bounded outputs, `outputSchema`, resource links, and possibly UI metadata. Those semantics are not reliably inferred from arbitrary HTTP routes.

Keep the HTTP API, CLI, and MCP adapter on shared Effect use-case services:

```text
Effect service -> HTTP handler
             -> CLI command
             -> MCP tool/resource handler
```

The MCP server must not shell out to the CLI. The CLI is an HTTP client or direct client of the same domain service, depending on whether it is local or remote.

Keep the pinned official MCP SDK as the default protocol implementation. Installed Effect 4 also has `effect/ai/McpServer` and a `2026-07-28` protocol adapter; it is a review alternative, not evidence that Goblin uses it. Replacing the existing SDK/Agents integration needs a concrete simplification or missing-capability benefit. Do not maintain two independent MCP stacks.

## 5. Current MCP protocol position

The latest released protocol revision is `2026-07-28`. “MCP 2.0” is best understood as the v2 SDK line plus this protocol revision, rather than as the formal protocol name.

Relevant changes in `2026-07-28`:

- Streamable HTTP is the preferred remote transport; HTTP+SSE is deprecated for new implementations.
- The core transport is stateless: no required `initialize`/`initialized` exchange and no `Mcp-Session-Id` dependency.
- `server/discover` can advertise capabilities and identity.
- Stateful work uses explicit server-minted handles passed in normal request arguments.
- `Mcp-Method` and `Mcp-Name` headers support routing, authorization, and telemetry.
- Tool/resource/prompt list results carry cache hints and should be deterministic.
- `subscriptions/listen` replaces the old GET/SSE and resource-subscription mechanisms for opted-in change notifications.
- Tasks moved into the official `io.modelcontextprotocol/tasks` extension, using `tasks/get`, `tasks/update`, and `tasks/cancel`.
- Multi-Round-Trip Requests return `input_required` results rather than relying on a server-initiated request over a held-open stream.
- New implementations should not add Roots, Sampling, or MCP Logging; those features are deprecated, though legacy clients remain relevant.
- Authorization is hardened around issuer validation and issuer-bound credentials. Dynamic Client Registration remains for compatibility but is moving toward Client ID Metadata Documents.
- OpenTelemetry context propagation conventions use `_meta` fields such as `traceparent`, `tracestate`, and `baggage`.

For Goblin as a **client**:

- Continue using the official v2 client and Streamable HTTP.
- Keep automatic negotiation and legacy compatibility while clients migrate.
- Use resources/templates for documents and structured records, tools for operations, and prompts only for reusable procedures.
- Use MCP Apps when a server supplies a `ui://` resource and keep the existing sandbox/origin/grant protections.
- Use Tasks for long-running remote work.
- Use `subscriptions/listen` for catalog/resource changes.
- Do not newly implement Sampling, Roots, or MCP Logging unless a concrete compatibility requirement justifies it.

For Goblin as a **server**:

- Keep `/mcp` as a native endpoint using the official server SDK and Agents SDK handler.
- Preserve OAuth consent, audience binding, user-to-Agent routing, and exact per-user access.
- Add curated observability tools instead of exposing every internal endpoint or database query.
- Add resources/templates for conversation and run records.
- Add Tasks when an inspection/export cannot complete in one call.
- Add an MCP App for a run timeline or conversation inspector after the structured tools are useful.
- Emit deterministic catalogs, bounded structured output, cache metadata, correlation IDs, and protocol/transport telemetry.

## 6. MCP Apps, Tasks, and Events

### MCP Apps

MCP Apps are a stable official extension. A tool advertises a `ui://` resource; the host renders it in a sandboxed iframe; UI actions return through the host's MCP channel. Use the extension helpers rather than hand-rolling metadata. UI-only helper tools can use the extension's visibility controls so they are callable by the App without unnecessarily entering the model's tool catalog.

For Goblin, a first App could show:

- run state and lifecycle timeline;
- conversation and Pi entry links;
- tool call inputs/results;
- model and MCP span timing;
- missing or delayed telemetry markers.

The App remains a view. Authorization and data access stay in the MCP server and Agent DO services.

### Tasks

Tasks are the best released protocol fit for long-running calls. `ask_agent` currently has Goblin-specific `operationId` and `running` behavior. A future compatibility layer can map long calls to MCP task handles while preserving operation-id idempotency internally.

Do not hold a transport stream open across Durable Object eviction or alarm recovery. Persist the task/run state and let the MCP client poll or subscribe to updates.

### Events

`subscriptions/listen` is released core protocol behavior for opted-in change notifications. The separate MCP Triggers & Events repository is explicitly experimental and is still working on event types, callback/subscription lifecycle, delivery semantics, ordering, gaps, and retries.

Goblin’s current outbound Events implementation follows a draft profile. Keep it versioned and capability-gated. Do not claim broad interoperability with arbitrary MCP servers until the official Triggers & Events work stabilizes.

For Goblin’s own background run completion, use durable run state plus MCP Tasks first. Add experimental event delivery only behind an explicit extension and durable cursor/gap semantics.

## 7. Authentication and authority

**Proposed:** begin with the owner's consenting MCP connection and a clearly authorized inspection capability. A separate operator role is only needed if product debugging must cross owners. Do not quietly broaden the current per-owner boundary to every user. MCP read-only annotations are hints, not access control; enforce policy in the shared service on every transport.

The remote CLI's HTTP authentication is an open design question. The owner HTTP API currently uses a browser session; inbound MCP tokens name `/mcp` as audience. Do not assume that token can be reused at `/api/*`. Choose an explicit CLI OAuth/audience/scope design, or evaluate a CLI using the native MCP client, before claiming remote CLI access works.

The review should validate:

- whether Better Auth’s current MCP flow supports or needs an explicit migration path toward Client ID Metadata Documents;
- issuer (`iss`) validation and issuer-bound credential storage;
- audience binding to `/mcp`;
- per-user Agent selection from the authenticated principal;
- separate read-only observability tools from `ask_agent` and other mutating tools, without treating an inspection as permission to execute a model or extend resident authority;
- bounded page sizes and result bytes;
- audit records for inspections;
- no raw secrets, OAuth tokens, credentials, or unbounded prompt content in logs, Apps, Basin events, or tool descriptions.

## 8. Recommended implementation sequence

1. Add an Effect service for read-only Goblin inspection. Read Pi through Pi APIs and application state through typed Drizzle services. Do not query Pi/vendor tables directly.
2. Define schemas for the inspection results in `@goblin/contracts` and give each result freshness/completeness/source metadata.
3. Add the first HTTP observation group using `HttpApi`; retain existing routes until the new contract is proven.
4. Add a thin CLI over the typed client.
5. Add native inbound MCP tools over the same service. Keep tool count small and operations high-level.
6. Add `resources/read` or resource templates for paginated conversation/run documents.
7. Add MCP Tasks for slow inspections/exports and preserve stable operation IDs.
8. Add an MCP App only after the structured tool surface is useful.
9. Add an event-index projection for Cloudflare log/trace references if cross-source search is needed. Keep Pi content authoritative.
10. Add Cloudflare Traces and Effect span correlation, using `runId` plus MCP `_meta` trace context rather than relying on opaque provider IDs alone.

Phase boundary: ship one conversation read through HTTP, CLI, and MCP first. Search across all records, log federation, Tasks, Apps, Basin, and custom event delivery are subsequent scope choices, not prerequisites for that slice. A simple task/run state read can be useful before a standards-level Tasks mapping is implemented.

Effect observability should use shared log annotations, named spans, typed failures, interruption outcomes, and usage hooks. The installed Alchemy native tracer captures invocation-specific async context and explicitly warns against caching a built tracer across requests. Goblin's long-lived DO runtime therefore needs a bounded proof with overlapping requests and alarms before a telemetry layer is considered drop-in. Alchemy infrastructure modules must not enter the runtime bundle.

Do not begin by migrating every existing route or generating every endpoint into an MCP tool. Prove the observability group end to end first.

## 9. Review questions and future acceptance criteria

Resolve these questions in the review, rather than treating the research as a final implementation spec:

1. Is `HttpApi` the smallest incremental fit for the existing native Worker router, or can current route/schema declarations be reflected with less disruption?
2. What existing generator or tiny adapter can derive CLI registration and MCP schemas while preserving a curated tool surface? Comparative evaluation of generator/framework candidates was not completed by this research.
3. Which authorization boundary lets the remote CLI and MCP inspect the same records without reusing a token for the wrong audience?
4. What does full conversation inspection include: inherited fork history, closed threads, tools, memory/compaction records, tasks, submissions, and exact model-input capture? Which existing Pi reads are complete and stable?
5. How should Pi runs map to MCP Tasks: handle scope, lifetime, polling, cancellation, input-required states, and external-effect receipts? A Pi acceptance receipt is not completion of an external action.
6. The release changelog describes task handles returned without per-request task opt-in; current extension material still describes client extension declaration. Confirm the canonical capability and fallback rules from the versioned Tasks specification and installed package, rather than relying on shorthand release prose.
7. Which capabilities does the current Agents SDK inbound handler actually expose on each protocol era? Pinning SDK v2 alone does not prove full protocol or host conformance.
8. Is an inbound Goblin MCP App worth adding now? Which target hosts support it, and what is the plain structured/text fallback?
9. What is the smallest retained correlation record needed to retrieve a conversation's logs without requiring Basin? Is native Cloudflare/Effect trace propagation across Railway and outbound MCP actually proven?
10. How far does the current draft Events implementation differ from the latest working-group sketch? Keep normal UI/Pi SSE, core subscriptions, task updates, and external business Events distinct.

Future implementation acceptance:

- Can connect to Goblin over the current `/mcp` endpoint using the pinned SDK line and inspect one authorized Agent only.
- Can list conversations and read complete, paginated Pi entries without direct vendor-table SQL.
- Can inspect task/submission/recovery state and distinguish accepted, running, completed, failed, stopped, and unknown.
- Can correlate a run to structured Workers Logs/Traces using stable application IDs.
- Can run equivalent read operations through the CLI and HTTP API with the same decoded schemas.
- Does not expose secrets or allow arbitrary SQL, arbitrary Agent selection, or mutating operations through the read-only surface.
- Handles legacy MCP clients while negotiating the `2026-07-28` protocol when supported.
- Verifies the MCP App in a real compatible host separately from unit tests.
- Treats the draft Events profile as experimental and tests gap/retry/cursor behavior before relying on it.

Test an unauthorized conversation, cross-owner denial, complete history across compaction/forks, bounded pagination, revoked-client access, absence of model calls during reads, and output-schema parity across transports. For Tasks or subscriptions, additionally test cancellation, disconnect/retry, restart recovery, and tenant-bound handles. Host/browser acceptance is separate from local fixture evidence.

## 10. Primary sources

- [MCP `2026-07-28` specification changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP `2026-07-28` release announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [Official TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk)
- [TypeScript SDK v2 support and migration notes](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [MCP Apps documentation](https://apps.extensions.modelcontextprotocol.io/)
- [MCP Apps stable extension announcement](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
- [MCP Tasks `2026-07-28` extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks)
- [MCP Triggers & Events working group](https://github.com/modelcontextprotocol/experimental-ext-triggers-events)
- [MCP Triggers & Events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md)
- [Effect `HttpApi`](https://effect.website/docs/v4/api/effect/http-api/HttpApi)
- [Effect OpenAPI generation](https://effect.website/docs/v4/api/effect/http-api/OpenApi)
- [Effect OpenAPI generator](https://github.com/Effect-TS/effect/tree/main/packages/tools/openapi-generator)
- [Cloudflare Durable Objects Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/)
- [Cloudflare Durable Object SQLite API and cursor semantics](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare unified Logs](https://developers.cloudflare.com/observability/logs/)
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Cloudflare Workers Traces](https://developers.cloudflare.com/workers/observability/traces/)
- [Cloudflare Workers Observability](https://developers.cloudflare.com/workers/observability/)
- [Cloudflare Log Explorer product page](https://www.cloudflare.com/products/log-explorer/)
- [Cloudflare Analytics SQL Workers binding and dataset limitations](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)
- [Cloudflare Basin announcement](https://www.cloudflare.com/press/press-releases/2026/cloudflare-launches-basin-a-more-open-and-accessible-data-platform-for-developers/)

GitHub discussion/review pointers, not independent proof of released behavior:

- [Reference servers' `2026-07-28` migration tracker, issue 4857](https://github.com/modelcontextprotocol/servers/issues/4857)
- [Triggers & Events long-polling field report, issue 4](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/issues/4)
- [MCP roadmap and work-group composition priorities](https://modelcontextprotocol.io/development/roadmap)

Research depth: primary release documentation, source/declaration inspection, official repository pages, and selected public search results. This was not an exhaustive framework comparison or an interoperability implementation. Search snippets and discussions are leads for the reviewer; normative documents and pinned code should decide behavior.

Earlier public Cloudflare research copies were kept in scratch directories on the dev box; they are convenience caches and are not required to read this handoff. Refresh drift-prone claims before implementation.

Before editing, read the root and workspace AGENTS.md files and applicable MCP/Apps/Effect skills. Preserve concurrent edits and `.spec.md.swo`; never stash/reset/restore foreign work. Work on main and stage only owned paths. Expensive implementation checks run through `heavy`; exit 75 means contention. No credentials, raw Alchemy state, private conversation content, or secret values belong in the review report.

## 11. Benchmark design comments for the implementation plan

These are planning comments from the benchmark side. They are proposed requirements, not shipped behavior. The goal is to make the observability contract useful for evaluating the real resident-agent work we care about, rather than only testing memory recall or coding tasks.

### 11.1 Benchmark unit and experiment arms

The primary unit should be a real Hermes-style continuation:

```text
real history prefix
  -> real owner request
  -> model turns and memory/search calls
  -> ordinary agent tools
  -> readback of the requested state or artifact
  -> accepted, failed, or unknown outcome
```

The benchmark must preserve the existing real corpus, manifests, ledgers, and sealed evidence. A memory index or OptChat artifact should be built once for a fixed history and reused by all compatible continuation tasks. Rebuilding it per task would measure construction repeatedly and would not represent how a resident agent works over time. Cold construction, extension, and warm reuse should remain separate measurements.

The first comparison can retain the four useful memory arms:

- native memory;
- native memory plus source search;
- OptChat memory;
- OptChat memory plus source search.

Every arm receives the same history cutoff, owner request, permission set, model budget, destination, and acceptance procedure. A no-memory baseline can be added later, but it should not delay the first real continuation slice.

### 11.2 Canonical run timeline

The benchmark needs one append-only timeline that can later be returned by `observe_run`. Suggested event kinds are:

```text
run.started
turn.started
model.attempt
memory.lookup
tool.call
artifact.receipt
turn.completed
task.accepted
task.failed
run.recovered
```

Every event should carry a small common envelope:

```text
runId, conversationId, taskId, turnId, operationId, parentEventId
startedAt, firstByteAt, endedAt
model, phase, status, retryIndex
inputTokens, outputTokens, reasoningTokens, cacheTokens
source, freshness, completeness, cursorOrGap
```

Keep full prompts, tool payloads, credentials, and private source text in the existing protected evidence paths. The timeline should contain bounded summaries, hashes, sizes, and references. `unknown` means that telemetry is missing; it must not be converted into zero.

### 11.3 Metrics needed for real task comparison

The report should expose these per task and per arm:

- task acceptance rate, with the independent readback that established it;
- end-to-end duration, time to first token, time to first useful action, and time to accepted result;
- user turns, model generations, subagent runs, and clarification/intervention turns;
- total tool calls, memory/search calls, denied calls, retries, failures, and returned bytes;
- input, output, reasoning, cache, and charged/reserved token totals, with coverage for each;
- actual model attempts and route/provider identity;
- interruption, cancellation, restart, and recovery outcomes;
- duplicate writes, wrong destinations, unauthorized effects, and stale-read failures;
- artifact/state diff or receipt identifiers, before/after versions, and acceptance status.

Memory retrieval must be reported separately from ordinary task tools. `toolCalls` must not mean only `archive_search` and `archive_read`; it must include the complete tool sequence, with a breakdown by family. The current benchmark already measures API attempts, token usage, retries, latency, retrieval bytes, and semantic recall, but its `EpisodeResult` still describes an answer rather than a delivered task. The continuation result needs a task outcome and artifact receipts alongside the existing recall score.

### 11.4 Acceptance and evidence rules

An answer that sounds plausible is not task success. A task is accepted only when a bounded independent readback verifies the requested result: for example, a destination document has the expected revision, a queue item has the expected state, or a repository snapshot passes the declared checks. Pi acceptance, model completion, or a successful HTTP response alone is insufficient for an external-effect claim.

Reports should distinguish:

```text
model_completed
pi_accepted
artifact_readback_passed
task_accepted
task_failed
task_unknown
```

Failed and unfinished attempts stay in denominators and cost totals. Missing logs, missing provider usage, delayed event-index rows, and partial cross-source joins must appear as completeness gaps. A run cannot be promoted to a product conclusion when acceptance receipts or telemetry coverage are incomplete.

### 11.5 How the benchmark and inspector should share data

The benchmark should emit the same portable `BenchmarkRun`/`TaskOutcome` shape that the future HTTP, CLI, and MCP inspector consume. This allows one run timeline to answer both questions:

1. Did this memory strategy complete the owner's task efficiently and safely?
2. Can an operator or coding agent explain what happened without opening raw Durable Object tables?

The first useful inspector response is therefore a bounded run timeline with links to conversation entries, model attempts, tool calls, and receipts. Include source, freshness, completeness, and cursor/gap metadata in the response. Do not make the benchmark depend on Cloudflare Logs, Basin, or a finished MCP App; local Pi/native evidence should be sufficient for the first vertical slice, with platform logs joined when available.

### 11.6 Smallest useful implementation slice

The implementation plan should start with one genuine, read-only or disposable-destination continuation task and two memory arms, then expand to all four arms after the telemetry is trustworthy:

1. Define the event envelope and task-outcome schemas without changing sealed historical artifacts.
2. Derive a timeline from existing benchmark traces/results and add explicit turn/tool timing where it is currently absent.
3. Add one real continuation with a stable operation ID, bounded tools, and an independent readback receipt.
4. Render a machine-readable report containing the timeline, acceptance result, tokens, latency, turns, tool calls, retries, and gaps.
5. Reuse that same report shape for a read-only `observe_run` service; add CLI/MCP transport adapters only after the service result is stable.

The plan should decide the task families, staging destinations, per-task token/time/tool ceilings, model matrix, minimum telemetry coverage, and preregistered success thresholds before spending on a larger run. The existing recall benchmark remains valuable as a diagnostic component, but recall gains alone must not be treated as proof that a resident agent can carry out the next owner request.
