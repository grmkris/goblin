# Architecture decision records

One decision per file, numbered in order. A new decision that replaces an old one is a new ADR that says what it
supersedes; the old ADR moves to [archive/](archive/README.md) and is not edited again. The row below keeps the current
status; a partly replaced ADR stays here and names what replaced which part.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-runtime-and-auth-storage.md) | Native Pi runtime and identity storage | Accepted; amended by 0064 |
| [0002](0002-stages-and-provider.md) | Isolated stages and provider planes | Accepted; amended by 0059, 0064 and 0067 |
| [0003](0003-resident-mcp-and-inbound-server.md) | The agent object owns MCP, holds its own authority, and serves /mcp | Accepted; amended by 0081 and 0088; its `ask_agent` and `get_recent_messages` superseded by 0119 |
| [0004](0004-an-agent-per-user.md) | An agent per user, with gated sign-up | Accepted; amended by 0064; its routing superseded by 0089 |
| [0005](0005-mcp-apps-host.md) | One live MCP App on a stage, told about its host, trusted for nothing | Accepted; its one live App superseded by 0020 |
| [0006](0006-servers-the-owner-adds.md) | Servers the owner adds are a trust boundary, not a configuration change | Accepted |
| [0007](0007-one-main-conversation.md) | One main conversation that never ends, with side threads and subagents | Accepted; amended by 0010, 0017, 0018 and 0032 |
| [0008](0008-skills-from-mcp-servers.md) | Skills come from MCP servers the owner turns them on for, and the agent drafts new ones for review | Accepted; amended by 0063 |
| [0009](archive/0009-telegram-through-myagent.md) | Telegram through myagent | Superseded by 0066 and 0069 |
| [0010](0010-per-conversation-capabilities-and-thread-notes.md) | Per-conversation capabilities, and main learns the names of threads started with "+" | Accepted; its per-conversation switches superseded by 0040 |
| [0011](0011-mcp-events.md) | MCP Events consumer | Accepted; amended by 0066 and 0073 |
| [0012](0012-routines.md) | Confirmed routines and isolated run threads | Accepted; its event metadata scrub superseded by 0104 |
| [0014](0014-members-and-workspace-authority.md) | Members and workspace authority | Withdrawn; members came with 0093 |
| [0016](0016-workspace-layout-with-trellis.md) | Workspace layout with Trellis | Superseded by 0019, then 0036 |
| [0017](0017-conversation-tree-and-one-close.md) | A tree of conversations, threads from anywhere, one Close | Accepted |
| [0018](0018-subagents-nest-steer-and-close.md) | Subagents nest, steer and close | Accepted |
| [0019](0019-panes-for-everything.md) | Panes for everything | Superseded by 0036 |
| [0020](0020-durable-apps-one-iframe-per-instance.md) | Durable Apps, one iframe per instance | Accepted; amended by 0067 |
| [0021](0021-agent-apps.md) | Agent apps | Accepted; amended by 0070 and 0078 |
| [0022](0022-owner-files-shell-and-r2.md) | The owner's files, in Shell's Workspace and R2 | Accepted; amended by 0065 and 0115 (files per Topic, and a Shared folder) |
| [0023](0023-chat-blocks-and-one-kit.md) | Chat blocks, one kit | Accepted |
| [0024](0024-observing-conversations.md) | Observing conversations | Accepted; amended by 0084, 0086, 0107 |
| [0027](0027-typed-tools.md) | Typed tools and one `app_call` | Accepted; amended by 0067 and 0101 |
| [0028](0028-mcp-call-approvals.md) | Owner approval for an exact MCP call | Accepted |
| [0029](0029-composer-commands-and-references.md) | Composer commands, references and helper execution | Accepted; amended by 0067 |
| [0030](0030-logical-chats-over-pi-sessions.md) | Logical chats over Pi sessions | Accepted; amended by 0067 |
| [0032](0032-topics-and-per-topic-memory.md) | Topics and per-Topic memory | Accepted |
| [0033](0033-personas.md) | Personas, organize receipts and Delegate results | Accepted; amended by 0067, 0100, 0101 and 0102; its `ask_user` denial superseded by 0082; its `SendMessage.personaOrder` superseded by 0111 |
| [0034](0034-move-to-thread.md) | Start thread and Move to thread | Accepted; amended by 0067; its `StartThread` body superseded by 0111 |
| [0035](0035-cross-topic-retrieval.md) | Cross-Topic retrieval | Accepted; amended by 0067 and 0115 (search covers the boundary: a hub's every Topic, a sealed Topic itself) |
| [0036](0036-slack-style-shell.md) | Slack-style shell | Accepted; amended by 0053; its rail and sidebar superseded by 0078 |
| [0037](0037-conversation-flows-and-failure-reporting.md) | Conversation flows and failure reporting | Accepted; amended by 0124 (its flow points and references are read through Cloudflare's MCP) |
| [0038](0038-typed-owner-api-served-by-the-agent.md) | Typed owner API served by the agent | Accepted; amended by 0081 |
| [0039](0039-chat-markdown-through-streamdown.md) | Chat Markdown through Streamdown, and what a reply may load | Accepted |
| [0040](0040-topic-and-persona-setup.md) | Topic setup and Persona setup | Accepted; amended by 0067 |
| [0041](0041-connections-tell-me-hand-to.md) | Connections, Tell me and Hand to | Accepted; amended by 0066, 0068, 0070 and 0073; its notice scrub superseded by 0104 |
| [0042](0042-mcp-2026-client.md) | MCP 2026 client: live tool lists, URL requests and step-up | Accepted |
| [0046](0046-production-promotion-and-public-source.md) | Daily development, deliberate production promotion and public source | Accepted; amended by 0077, 0106 |
| [0052](0052-one-mysi-connection-and-a-shelf-that-needs-no-sign-in.md) | One mysi connection and a shelf that needs no sign-in | Accepted; amended by 0061, 0063, 0075 and 0096 |
| [0053](0053-pinned-services-and-apps-with-a-chat-bar.md) | Pinned services and Apps with a chat bar | Accepted; amended by 0063; its pins by default superseded by 0078 |
| [0055](archive/0055-telegram-chats-route-to-topics.md) | Telegram chats route to Topics | Superseded by 0066 and 0069 |
| [0056](0056-goblin-wallet-leaves-goblin.md) | Goblin Wallet leaves goblin | Accepted |
| [0057](0057-goblin-pays-for-no-model-call.md) | goblin pays for no model call | Accepted |
| [0058](0058-no-plans-tokens-and-an-optional-cap.md) | No plans: access by sign-up, usage in tokens with an optional cap | Accepted |
| [0059](0059-bring-your-own-model-endpoint.md) | Bring your own model endpoint | Accepted; amended by 0064 |
| [0060](0060-suggested-access-from-tool-annotations.md) | Suggested access from tool annotations | Accepted |
| [0061](0061-the-shelf-is-data.md) | The shelf is data | Accepted |
| [0062](0062-short-skippable-start.md) | Short, skippable Start | Amended by 0079 |
| [0063](0063-mcp-first-no-server-specific-code.md) | MCP-first: no server-specific code | Accepted |
| [0064](0064-openid-connect-and-config-driven-deployment.md) | OpenID Connect sign-in and config-driven deployment | Accepted; amended by 0067 and 0078 |
| [0065](0065-files-from-mcp-content.md) | Files from MCP content | Accepted; amended by 0115 (kept in the Topic's own folder) |
| [0066](0066-sources.md) | Sources: any MCP server's events carry the owner's own messages, by a setup the owner confirms | Accepted; amended by 0068, 0072 and 0096 |
| [0067](0067-no-home-surface-and-no-typed-decisions.md) | No Home surface and no typed decisions | Accepted |
| [0068](0068-events-use-their-standard-fields-only.md) | Events use their standard fields only | Accepted; amended by 0096 |
| [0069](0069-external-messages-use-sources.md) | External messages use Sources; the built-in Telegram channel is removed | Accepted |
| [0070](0070-notices-and-files-leave-through-the-owners-tools.md) | Notices and files leave through the owner's own tools: Notify me via and file links | Accepted; amended by 0071 |
| [0071](0071-sink-delivery-rules-and-event-identity.md) | Sink delivery rules and exact event identity | Accepted |
| [0072](0072-source-reply-result-outcomes.md) | Source reply result outcomes and durable piece progress | Accepted; amended by 0096 |
| [0073](0073-event-lease-callback-generations.md) | Event lease callback generations | Accepted; amended by 0096 |
| [0074](0074-interactive-replies.md) | Interactive replies are ordinary owner follow-ups | Accepted |
| [0075](0075-production-mysi-on-every-stage.md) | goblin uses production mysi on every stage | Accepted |
| [0076](0076-batch-tool-grants.md) | Batch changes to exact tool grants | Accepted |
| [0077](0077-prod-is-the-default-branch.md) | prod is the repository's default branch | Accepted |
| [0078](0078-one-sidebar-and-one-apps-launcher.md) | One sidebar and one Apps launcher | Accepted |
| [0079](0079-channel-info-and-goal-first-start.md) | Channel info and goal-first Start | Accepted; amended by 0080 |
| [0080](0080-server-owned-start-kickoff.md) | Server-owned Start kickoff | Accepted |
| [0081](0081-api-keys-and-the-same-operations-over-mcp.md) | Scoped API keys for servers, and the same operations over /mcp | Accepted; amended by 0084, 0085, 0086, 0089, 0090, 0091, 0105, 0108, 0109, 0110, 0112, 0114, 0115; its message body superseded by 0111; its scopes superseded by 0114; amended by 0118 (a product or a script installs as an app instead); its keys superseded by 0125 (an installed or script app instead) |
| [0082](0082-personas-ask-with-ask-user.md) | A tagged Persona asks with ask_user | Accepted |
| [0083](0083-bounded-thinking-and-a-turn-that-answers.md) | Bounded thinking, and a turn that answers | Accepted; amended by 0100 |
| [0084](0084-a-key-reads-back-what-it-made-and-how-it-ran.md) | A key reads back what it made, and how its chats ran | Accepted; amended by 0091, 0107, 0114; its key superseded by 0125 (any credential reads back by its grant) |
| [0085](0085-a-keys-rate-limit-is-a-fixed-minute-counted-by-its-agent.md) | A key's rate limit is a fixed minute, counted by its agent | Accepted; amended by 0086; its key superseded by 0125 (every caller, ADR 0086) |
| [0086](0086-one-mcp-for-every-caller.md) | One /mcp for every caller | Accepted; amended by 0089, 0090, 0094, 0097, 0098, 0112, 0114, 0116 (an OAuth client also uses the owner API), 0118 (an installed app's token too) and 0119 (a send is a task; `ask_agent` and `get_recent_messages` gone) |
| [0087](0087-the-owners-own-subscription-models.md) | The owner's own subscription models | Accepted; amended by 0089 and 0115 (a server's work is a key's sending, wherever) |
| [0088](0088-resident-authority-lasts-until-revoked.md) | Resident authority lasts until revoked | Accepted |
| [0089](0089-workspaces-own-agents.md) | Workspaces own agents | Accepted; amended by 0093 and 0116 (an OAuth client's path names its workspace); its consent naming one workspace superseded by 0097; amended by 0118 (an app's installation names its workspace) |
| [0090](0090-a-key-names-closes-and-reads-back-its-threads.md) | A key names, closes and reads back its threads | Accepted; amended by 0103; its key superseded by 0125 (any credential, by its grant) |
| [0091](0091-a-key-names-the-mcp-servers-its-threads-may-use.md) | A key names the MCP servers its threads may use | Accepted; amended by 0114 (origins are any credential's grant's); its key superseded by 0125 (any credential's grant) |
| [0092](0092-mcp-calls-are-checked-against-their-schema-and-keep-the-servers-message.md) | MCP calls are checked against their schema and keep the server's message | Accepted |
| [0093](0093-members-invitations-and-roles.md) | Members, invitations and roles | Accepted; amended by 0095, 0097, 0098 |
| [0094](0094-a-members-message-names-who-wrote-it.md) | A member's message names who wrote it | Accepted |
| [0095](0095-the-owners-subscription-workspace-takes-no-members.md) | The owner's subscription workspace takes no members | Accepted |
| [0096](0096-a-source-configures-itself-from-its-servers-guide.md) | A Source configures itself from its server's guide | Accepted |
| [0097](0097-one-mcp-reaches-the-workspaces-its-consent-chooses.md) | One /mcp reaches the workspaces its consent chooses | Accepted; amended by 0114 (the reach is the grant's) |
| [0098](0098-admin-for-configuration-and-every-mcp-power-opt-in.md) | Admin for configuration on every surface; every MCP power is opt-in | Accepted; amended by 0099, 0110, 0114 (its MCP powers are a grant's level and extras) and 0117 (`setup` reaches the connections themselves) |
| [0099](0099-a-members-turn-gets-a-members-tools.md) | A member's turn gets a member's tools | Accepted; built; amends 0098; amended by 0108, then 0115 (a member's turn is a member's power) |
| [0100](0100-a-persona-thinks-at-its-own-level.md) | A Persona thinks at its own level | Accepted |
| [0101](0101-a-persona-forks-mcp-tools-are-its-own.md) | A Persona fork's MCP tools are its own | Accepted; amended by 0102 |
| [0102](0102-native-tools-are-a-personas-choice.md) | Native tools are a Persona's choice | Accepted |
| [0103](0103-a-thread-declares-its-mcp-servers.md) | A thread declares the MCP servers its Personas call | Accepted |
| [0104](0104-routine-data-stays-as-its-producer-sent-it.md) | Routine data stays as its producer sent it | Accepted |
| [0105](archive/0105-a-keys-secret-rotates-in-place.md) | A key's secret rotates in place | Superseded by 0125 |
| [0106](0106-the-deploy-smoke-makes-no-model-call.md) | The deploy smoke makes no model call | Accepted |
| [0107](0107-a-turn-says-what-it-ran-with-and-reads-as-an-opentelemetry-trace.md) | A turn says what it ran with, and reads as an OpenTelemetry trace | Accepted; built |
| [0108](archive/0108-a-keys-topic-is-a-room.md) | A key's Topic is a room | Superseded by 0115 |
| [0109](0109-every-chat-streams-ag-ui-through-a-durable-stream.md) | Every chat streams AG-UI events through a durable stream | Accepted; built; amends 0081; its transport, join, signed URL, epochs and tiers superseded by 0110; the Durable Streams class removed from every stage (2026-10-24) |
| [0110](0110-the-agent-serves-every-chats-stream-to-every-reader.md) | The agent serves every chat's stream to every reader | Accepted; built; supersedes 0109's transport; amends 0081, 0098; amended by 0116 (an OAuth client reads it too) |
| [0111](0111-agui-run-input-is-the-send.md) | AG-UI's run input is the send, answered with its receipt or its run's events | Accepted; built; supersedes 0081's message body, 0034's `StartThread` and 0033's `SendMessage.personaOrder`; amended by 0119 (a send on `/mcp` is a task to a client that follows one) |
| [0112](0112-goblin-publishes-mcp-events.md) | goblin publishes MCP Events: `conversation.updated` by signed webhook or poll | Accepted; built; amends 0081, 0086; amended by 0116 (an OAuth client calls its methods over REST too); amended by 0118 (an installation holds leases) |
| [0113](0113-a-room-runs-in-its-own-object.md) | A room runs in its own object; the workspace object is the control plane | Accepted; slice 1 built, then undone by 0115 (rooms are gone); its later slices wait on a decision of their own |
| [0114](0114-one-grant-for-every-credential.md) | One grant for every credential: level, reach, extras and lifetime, for keys and OAuth clients alike | Accepted; release A built; amends 0081, 0084, 0086, 0091, 0097, 0098, 0105; amended by 0115 (what a turn may do), 0117 (what `setup` holds), 0118 (a grant of kind `app` per installation) and 0125 (kind `key` and the `keys` extra gone) |
| [0115](0115-every-topic-is-sealed.md) | Every Topic is sealed, with a hub; files per Topic; a turn's power is its sender's; rooms are gone | Accepted; release B built; supersedes 0108 and 0113's room keying; amends 0022, 0035, 0065, 0087, 0099, 0114 |
| [0116](0116-an-oauth-client-uses-the-owner-api-too.md) | An OAuth client uses the owner API too: its token on `/w/<slug>/api`, the stream included | Accepted; amends 0086, 0089, 0110, 0112; amended by 0118 (an installed app's token on the path too); its key on bare `/api` superseded by 0125 |
| [0117](0117-the-setup-extra-reaches-a-workspaces-connections.md) | The setup extra reaches a workspace's connections: adding, signing in, tool grants and skills with `manage` | Accepted; amends 0098, 0114 |
| [0118](0118-a-product-installs-into-a-workspace.md) | A product installs into a workspace: an app registered by one, installed in each with a grant, its own client_credentials token | Accepted; amends 0081, 0086, 0089, 0112, 0114, 0116; its keys remaining for scripts superseded by 0125 |
| [0119](0119-a-send-is-a-task-when-its-client-can-follow-one.md) | A send is a task when its client can follow one: the Tasks extension on `/mcp`, `conversation_send_status`, no `ask_agent` | Accepted; supersedes 0003's and 0086's `ask_agent` and `get_recent_messages`; amends 0086, 0111 |
| [0120](0120-type-and-effect-diagnostics-run-on-tsrs.md) | Type and Effect diagnostics run on tsrs: one effect-tsrs pass per project replaces tsc and effect-tsgo, `EFFECT_CHECKER=tsgo` falls back | Accepted; built; amended by 0121 (the fallback is gone; effect-tsrs 0.2.2) |
| [0121](0121-tsrs-only-the-fallback-is-gone.md) | tsrs only: the `EFFECT_CHECKER=tsgo` fallback is gone, and effect-tsrs moves to 0.2.2 with `--type-check` | Accepted; built; amends 0120 |
| [0122](0122-inbound-oauth-follows-the-mcp-authorization-spec.md) | Inbound OAuth follows the MCP authorization spec: Client ID Metadata Documents, bearer tokens without DPoP, redirects `localhost` or https, `offline_access` by rule, `invalid_token`, RFC 7009 | Accepted; built; amends 0024, 0086, 0114 |
| [0123](0123-type-aware-lint-runs-on-tsrs-lint.md) | Type-aware lint runs on tsrs-lint, a pinned release of our tsrs fork: `tools/tsrs-lint.ts` fetches and verifies it, oxlint-tsgolint is gone, no fallback | Accepted; built; amends 0120, 0121 |
| [0124](0124-cloudflare-data-is-read-through-cloudflares-mcp.md) | Cloudflare's own data is read through Cloudflare's MCP: the CLI's `logs`, `lookup` and `stats` go | Accepted; amends 0037 |
| [0125](0125-keys-are-gone.md) | Keys are gone: every credential is a person's client or an installed app | Accepted; supersedes 0105 and the key parts of 0081, 0084, 0085, 0090, 0091, 0114, 0116 and 0118 |
