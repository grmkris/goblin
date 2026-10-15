# Storage

## Storage

| Store | Tables | Owner |
| --- | --- | --- |
| Agent DO SQLite | `pi_*`, `cf_agents_*` and the other vendor tables | Pi, Agents SDK. Never touched. |
| Agent DO SQLite | `app_mcp_connections`, `app_mcp_registries`, `app_mcp_endpoints`, `app_mcp_credentials`, `app_mcp_oauth_pending`, `app_mcp_grants` | Drizzle: MCP metadata and authorization. |
| Agent DO SQLite | `app_resident`, `app_conversations`, `app_model_choice`, `app_usage_daily` | Drizzle: agent metadata and logical chat bindings (ADR 0030). `app_usage_daily` counts model tokens per UTC day (ADR 0058). |
| Agent DO SQLite | `app_chat_operations` | Drizzle: operation receipts per chat, pinned to their original Pi session, with kind, origin, target chat, parent operation, state and reason, pruned opportunistically after 30 days (ADR 0030). |
| Agent DO SQLite | `app_conversation_capabilities`, `app_execution_exclusions` | Drizzle: a helper's exclusions, set by its spawner (ADRs 0018, 0029); the owner's per-conversation switches were deleted (ADR 0040). |
| Agent DO SQLite | `app_persona_chats` | Drizzle: the setup a Persona answers with in a chat: its fork, frozen at the ask (ADR 0040), or a routine's run at the pinned revision (ADR 0041). |
| Agent DO SQLite | `app_chat_memory_log`, `app_chat_memory_nodes`, `app_chat_memory_state` | Drizzle: each Topic Conversation's memory, keyed by chat id (ADR 0032). |
| Agent DO SQLite | `app_topics` | Drizzle: the owner's Topics, each with its Conversation's chat id (ADR 0032) and its setup (ADR 0040). |
| Agent DO SQLite | `app_transcript_excerpts`, `app_transcript_fts` (FTS5, shadow tables `app_transcript_fts_*`), `app_transcript_index`, `app_retrieval_uses` | Drizzle and raw FTS5 SQL: the cross-Topic transcript index and the frozen sources each run used (ADR 0035). |
| Agent DO SQLite | `app_skill_sources`, `app_skill_activations`, `app_skill_files`, `app_skill_drafts` | Drizzle: skills, and the learner's log of the drafts it wrote to the owner's files. |
| Agent DO SQLite | `app_source_setups`, `app_source_routes`, `app_source_held`, `app_source_replies`, `app_notify_sink` | Drizzle: Sources' confirmed setups and bindings, each conversation's route and title, what waits for a route (with the files it brought, by reference), the answers owed, and Notify me via (ADRs 0066, 0071). |
| Agent DO SQLite | `app_mcp_event_grants`, `app_mcp_event_subscriptions`, `app_event_deliveries`, `app_mcp_event_consumers`, `app_event_consumer_receipts` | Drizzle: exact Events grants, leases, encrypted receipts and independent acknowledgements. |
| Agent DO SQLite | `app_skill_catalog_state` | Drizzle: durable catalog invalidation generations. |
| Agent DO SQLite | `cf_workspace_files` | `@cloudflare/shell`'s Workspace: the owner's files (ADR 0022), vendor-owned like `pi_*`. |
| R2 `files` | `agents/<userId>/files/…`, `agents/<userId>/app_<name>/…` | Shell: the owner's and each app's files over 128 KiB. Deleting the account empties the prefix. |
| Agent DO SQLite | `app_agent_apps`, `app_agent_releases`, `app_agent_artifacts`, `app_agent_views`, `app_agent_state`, `app_agent_snapshots`, `app_agent_receipts`, `app_agent_events`, `app_agent_powers`, `app_agent_usage`, `app_agent_jobs` | Drizzle: agent apps, their releases, code and views, state and revisions, rollback snapshots, receipts, events, the owner's answers to their powers, their daily usage and their schedules (ADR 0021). |
| Agent DO SQLite | `cf_workspace_app_<name>` | Shell: each agent app's own files. |
| Agent DO SQLite | `app_registry` | Drizzle: every App the workspace shows, by source: an MCP App per Pi session and call, with logical `chat_id` placement, an agent app per name (ADRs 0020, 0021, 0030). |
| Agent DO SQLite | `app_run_events` | Drizzle: the run ledger, turns, model attempts and tool calls without content, 30 days (ADR 0024). |
| D1 `goblinAuth` | `user`, `session`, `account`, `verification`, `jwks`, `rateLimit`, `oauth*` | Better Auth, `apps/runtime/migrations/0000_baseline.sql`. |

The auth D1 baseline contains the current schema: withdrawn billing, workspace, member and wallet tables are absent.
The disposable dev reset recreates this baseline; prod remains frozen until its separate reset decision.
The auth migration unit tests apply the baseline to SQLite, compare it with the installed Better Auth schema and
exercise constraints and MCP client registration. This verifies local schema behavior, not a deployed reset.

Application tables are declared in `storage/*.ts` and created by one inline baseline,
`storage/migrations/baseline.ts`, through `storage/migrations.ts`. It creates the 74 live Drizzle tables and the
FTS5 virtual table, its triggers and SQLite-owned shadow tables. It seeds Personal and the default routine settings.
The old billing, payment, spending, operator, member, Home, decision, channel and predecessor-memory tables and
columns are absent. Notice outbox fields use `copy_*`; each copy binds the sink revision it first attempted.

This is a fresh schema, with no upgrade path for the previous application or auth migrations. A release that changes
either baseline must reset disposable dev before recreating it, following the reset/setup checklist in
[development](../development.md). Existing deployments must not receive these migrations without that reset.
The separate production freeze remains in force.

Unit tests compare the baseline's complete table and column inventory with the current Drizzle declarations,
including types, defaults and nullability; they exercise partial uniqueness and FTS insert/update/delete triggers.
The native baseline canary applies it to an already populated Pi/Agents store, reapplies it, and checks vendor schema
and rows plus an application row. Native startup also compares table definitions across reapplication.

Logical chat identity keeps existing chat keys, capabilities, exclusions, titles, close/read marks and tree
parents stay in place. Pi entries, tasks, submissions, request ids and documents remain Pi-keyed, as do
`app_mcp_approvals`, MCP App call reads, `app_skill_activations` and `app_run_events`. `fork_entry`, `spawner_session`
and memory entry ids keep their original Pi identities. Routine reports, share-backs, thread-start notes and subagent
reports resolve the current target chat while its shared directory lock is held, then submit to Pi; passive write
acceptance starts no model turn and proves no external effect.

The chat layer has unit proof for lookup, operation retries, retention, CAS ownership and admission locks, plus a
local workerd profile that binds chat `1` to a fresh non-root Pi session in test subclasses before service
composition. Owner, helper, routine, Source and memory cases run under that profile; explicit owner and inbound
proofs assert the non-root session and an empty root transcript. The AST guard bans root constants and session-less
harness submission/session calls in the runtime's source (tests aside). These
prove local behavior; deployed-stage, live-provider,
Telegram-service and remote-eviction acceptance remain separate.

Better Auth lives in D1 because the Durable SQLite adapter's async transactions and affected-row semantics do not
meet its contract (ADR 0001). SQLite transactions are short and never span model or network calls.
