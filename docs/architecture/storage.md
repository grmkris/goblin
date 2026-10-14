# Storage

## Storage

| Store | Tables | Owner |
| --- | --- | --- |
| Agent DO SQLite | `pi_*`, `cf_agents_*` and the other vendor tables | Pi, Agents SDK. Never touched. |
| Agent DO SQLite | `app_mcp_connections`, `app_mcp_registries`, `app_mcp_endpoints`, `app_mcp_credentials`, `app_mcp_oauth_pending`, `app_mcp_grants` | Drizzle: MCP metadata and authorization. |
| Agent DO SQLite | `app_mcp_spend_rules`, `app_mcp_spend` | Unread until the migrations are squashed (ADR 0063). |
| Agent DO SQLite | `app_resident`, `app_conversations`, `app_model_choice`, `app_usage_daily`, `app_metadata` | Drizzle: agent metadata and logical chat bindings (ADR 0030). `app_usage_daily` counts model tokens per UTC day; its `milli_credits` is unread until the migrations are squashed (ADR 0058). |
| Agent DO SQLite | `app_chat_operations` | Drizzle: operation receipts per chat, pinned to their original Pi session, with kind, origin, target chat, parent operation, state and reason (`20261027000000_chat_operation_receipts`), pruned opportunistically after 30 days (ADR 0030). |
| Agent DO SQLite | `app_conversation_capabilities`, `app_execution_exclusions` | Drizzle: a helper's exclusions, set by its spawner (ADRs 0018, 0029); the owner's per-conversation switches were deleted (ADR 0040). |
| Agent DO SQLite | `app_persona_chats` | Drizzle: the setup a Persona answers with in a chat: its fork, frozen at the ask (ADR 0040), or a routine's run at the pinned revision (ADR 0041). |
| Agent DO SQLite | `app_chat_memory_log`, `app_chat_memory_nodes`, `app_chat_memory_state` | Drizzle: each Topic Conversation's memory, keyed by chat id (ADR 0032). `app_memory_log`, `app_memory_nodes` and `app_memory_state`, Main's agent-wide predecessors, were copied into chat `1` and are no longer read. |
| Agent DO SQLite | `app_topics` | Drizzle: the owner's Topics, each with its Conversation's chat id (ADR 0032) and its setup (ADR 0040). |
| Agent DO SQLite | `app_transcript_excerpts`, `app_transcript_fts` (FTS5, shadow tables `app_transcript_fts_*`), `app_transcript_index`, `app_retrieval_uses` | Drizzle and raw FTS5 SQL: the cross-Topic transcript index and the frozen sources each run used (ADR 0035). |
| Agent DO SQLite | `app_skill_sources`, `app_skill_activations`, `app_skill_files`, `app_skill_drafts` | Drizzle: skills, and the learner's log of the drafts it wrote to the owner's files. |
| Agent DO SQLite | `app_channel`, `app_telegram_channel`, `app_channel_replies` | Drizzle: Telegram transport checkpoints and replies. |
| Agent DO SQLite | `app_mcp_event_grants`, `app_mcp_event_subscriptions`, `app_event_deliveries`, `app_mcp_event_consumers`, `app_event_consumer_receipts` | Drizzle: exact Events grants, leases, encrypted receipts and independent acknowledgements. |
| Agent DO SQLite | `app_skill_catalog_state` | Drizzle: durable catalog invalidation generations. |
| Agent DO SQLite | `cf_workspace_files` | `@cloudflare/shell`'s Workspace: the owner's files (ADR 0022), vendor-owned like `pi_*`. |
| R2 `files` | `agents/<userId>/files/…`, `agents/<userId>/app_<name>/…` | Shell: the owner's and each app's files over 128 KiB. Deleting the account empties the prefix. |
| Agent DO SQLite | `app_agent_apps`, `app_agent_releases`, `app_agent_artifacts`, `app_agent_views`, `app_agent_state`, `app_agent_snapshots`, `app_agent_receipts`, `app_agent_events`, `app_agent_powers`, `app_agent_usage`, `app_agent_jobs` | Drizzle: agent apps, their releases, code and views, state and revisions, rollback snapshots, receipts, events, the owner's answers to their powers, their daily usage and their schedules (ADR 0021). |
| Agent DO SQLite | `cf_workspace_app_<name>` | Shell: each agent app's own files. |
| Agent DO SQLite | `app_registry` | Drizzle: every App the workspace shows, by source: an MCP App per Pi session and call, with logical `chat_id` placement, an agent app per name (ADRs 0020, 0021, 0030). `app_apps`, its predecessor, was copied in with the same ids and is no longer read. |
| Agent DO SQLite | `app_run_events` | Drizzle: the run ledger, turns, model attempts and tool calls without content, 30 days (ADR 0024). |
| Agent DO SQLite | `app_decision_proposals`, `app_decision_labels` | Drizzle: typed decision proposals and the owner's first label of each (ADR 0031). |
| D1 `goblinAuth` | `user`, `session`, `account`, `verification`, `jwks`, `rateLimit`, `oauth*` | Better Auth, `apps/runtime/migrations`. |
| D1 `goblinAuth` | `app_billing_accounts`, `app_billing_subscriptions`, `app_billing_inbox`, `app_billing_checkouts`, `app_billing_wallet_subscriptions` | Unread until the migrations are squashed (ADR 0058). |

The withdrawn Members feature left dormant auth D1 tables and DO columns/tables. Applied migration files and keys
remain intact to preserve real data and migration history; the runtime no longer reads or writes that access metadata.
See [ADR 0014](../adr/0014-members-and-workspace-authority.md) for the withdrawal.

Application tables are declared in `storage/schema.ts` and migrated inline by `storage/migrations.ts`, which applies
the area lists in `storage/migrations/` (`base.ts`, `conversation.ts`, `decisions.ts`, `setup.ts`) in key order.
`app_client_sessions` was dropped when inbound clients moved to main; it is not a current table.

Logical chat migration is additive: existing chat keys, capabilities, exclusions, titles, close/read marks and tree
parents stay in place. Pi entries, tasks, submissions, request ids and documents remain Pi-keyed, as do
`app_mcp_approvals`, MCP App call reads, `app_skill_activations` and `app_run_events`. `fork_entry`, `spawner_session`
and memory entry ids keep their original Pi identities. Routine reports, share-backs, thread-start notes and subagent
reports resolve the current target chat while its shared directory lock is held, then submit to Pi; passive write
acceptance starts no model turn and proves no external effect.

The chat layer has unit proof for lookup, operation retries, retention, CAS ownership and admission locks, plus a
local workerd profile that binds chat `1` to a fresh non-root Pi session in test subclasses before service
composition. Owner, helper, routine, channel and memory cases run under that profile; explicit owner and inbound
proofs assert the non-root session and an empty root transcript. The AST guard bans root constants, session-less
harness submission/session calls, and a `ChatDirectory` built outside the conversation layer (`layers/conversation.ts`)
and tests. These
prove local behavior; deployed-stage, live-provider,
Telegram-service and remote-eviction acceptance remain separate.

Better Auth lives in D1 because the Durable SQLite adapter's async transactions and affected-row semantics do not
meet its contract (ADR 0001). SQLite transactions are short and never span model or network calls.
