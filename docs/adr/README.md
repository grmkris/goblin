# Architecture decision records

One decision per file, numbered in order. A new decision that replaces an old one is a new ADR that says what it
supersedes; the old ADR moves to [archive/](archive/README.md) and is not edited again. The row below keeps the current
status; a partly replaced ADR stays here and names what replaced which part.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-runtime-and-auth-storage.md) | Native Pi runtime and identity storage | Accepted; amended by 0064 |
| [0002](0002-stages-and-provider.md) | Isolated stages and provider planes | Accepted; amended by 0059, 0064 and 0067 |
| [0003](0003-resident-mcp-and-inbound-server.md) | The agent object owns MCP, holds its own authority, and serves /mcp | Accepted |
| [0004](0004-an-agent-per-user.md) | An agent per user, with gated sign-up | Accepted; amended by 0064 |
| [0005](0005-mcp-apps-host.md) | One live MCP App on a stage, told about its host, trusted for nothing | Accepted; its one live App superseded by 0020 |
| [0006](0006-servers-the-owner-adds.md) | Servers the owner adds are a trust boundary, not a configuration change | Accepted |
| [0007](0007-one-main-conversation.md) | One main conversation that never ends, with side threads and subagents | Accepted; amended by 0010, 0017, 0018 and 0032 |
| [0008](0008-skills-from-mcp-servers.md) | Skills come from MCP servers the owner turns them on for, and the agent drafts new ones for review | Accepted; amended by 0063 |
| [0009](0009-telegram-through-myagent.md) | Telegram through myagent | Accepted; to be superseded by 0066 when the channel goes |
| [0010](0010-per-conversation-capabilities-and-thread-notes.md) | Per-conversation capabilities, and main learns the names of threads started with "+" | Accepted; its per-conversation switches superseded by 0040 |
| [0011](0011-mcp-events.md) | MCP Events consumer | Accepted; amended by 0066 |
| [0012](0012-routines.md) | Confirmed routines and isolated run threads | Accepted |
| [0014](0014-members-and-workspace-authority.md) | Members and workspace authority | Withdrawn |
| [0016](0016-workspace-layout-with-trellis.md) | Workspace layout with Trellis | Superseded by 0019, then 0036 |
| [0017](0017-conversation-tree-and-one-close.md) | A tree of conversations, threads from anywhere, one Close | Accepted |
| [0018](0018-subagents-nest-steer-and-close.md) | Subagents nest, steer and close | Accepted |
| [0019](0019-panes-for-everything.md) | Panes for everything | Superseded by 0036 |
| [0020](0020-durable-apps-one-iframe-per-instance.md) | Durable Apps, one iframe per instance | Accepted; amended by 0067 |
| [0021](0021-agent-apps.md) | Agent apps | Accepted; amended by 0070 |
| [0022](0022-owner-files-shell-and-r2.md) | The owner's files, in Shell's Workspace and R2 | Accepted; amended by 0065 |
| [0023](0023-chat-blocks-and-one-kit.md) | Chat blocks, one kit | Accepted |
| [0024](0024-observing-conversations.md) | Observing conversations | Accepted |
| [0027](0027-typed-tools.md) | Typed tools and one `app_call` | Accepted; amended by 0067 |
| [0028](0028-mcp-call-approvals.md) | Owner approval for an exact MCP call | Accepted |
| [0029](0029-composer-commands-and-references.md) | Composer commands, references and helper execution | Accepted; amended by 0067 |
| [0030](0030-logical-chats-over-pi-sessions.md) | Logical chats over Pi sessions | Accepted; amended by 0067 |
| [0032](0032-topics-and-per-topic-memory.md) | Topics and per-Topic memory | Accepted |
| [0033](0033-personas.md) | Personas, organize receipts and Delegate results | Accepted; amended by 0067 |
| [0034](0034-move-to-thread.md) | Start thread and Move to thread | Accepted; amended by 0067 |
| [0035](0035-cross-topic-retrieval.md) | Cross-Topic retrieval | Accepted; amended by 0067 |
| [0036](0036-slack-style-shell.md) | Slack-style shell | Accepted |
| [0037](0037-conversation-flows-and-failure-reporting.md) | Conversation flows and failure reporting | Accepted |
| [0038](0038-typed-owner-api-served-by-the-agent.md) | Typed owner API served by the agent | Accepted |
| [0039](0039-chat-markdown-through-streamdown.md) | Chat Markdown through Streamdown, and what a reply may load | Accepted |
| [0040](0040-topic-and-persona-setup.md) | Topic setup and Persona setup | Accepted; amended by 0067 |
| [0041](0041-connections-tell-me-hand-to.md) | Connections, Tell me and Hand to | Accepted; amended by 0066, 0068 and 0070 |
| [0042](0042-mcp-2026-client.md) | MCP 2026 client: live tool lists, URL requests and step-up | Accepted |
| [0046](0046-production-promotion-and-public-source.md) | Daily development, deliberate production promotion and public source | Accepted |
| [0052](0052-one-mysi-connection-and-a-shelf-that-needs-no-sign-in.md) | One mysi connection and a shelf that needs no sign-in | Accepted; amended by 0061 and 0063 |
| [0053](0053-pinned-services-and-apps-with-a-chat-bar.md) | Pinned services and Apps with a chat bar | Accepted; amended by 0063 |
| [0055](0055-telegram-chats-route-to-topics.md) | Telegram chats route to Topics | Accepted; to be superseded by 0066 when the channel goes |
| [0056](0056-goblin-wallet-leaves-goblin.md) | Goblin Wallet leaves goblin | Accepted |
| [0057](0057-goblin-pays-for-no-model-call.md) | goblin pays for no model call | Accepted |
| [0058](0058-no-plans-tokens-and-an-optional-cap.md) | No plans: access by sign-up, usage in tokens with an optional cap | Accepted |
| [0059](0059-bring-your-own-model-endpoint.md) | Bring your own model endpoint | Accepted; amended by 0064 |
| [0060](0060-suggested-access-from-tool-annotations.md) | Suggested access from tool annotations | Accepted |
| [0061](0061-the-shelf-is-data.md) | The shelf is data | Accepted |
| [0062](0062-short-skippable-start.md) | Short, skippable Start | Accepted |
| [0063](0063-mcp-first-no-server-specific-code.md) | MCP-first: no server-specific code | Accepted |
| [0064](0064-openid-connect-and-config-driven-deployment.md) | OpenID Connect sign-in and config-driven deployment | Accepted; amended by 0067 |
| [0065](0065-files-from-mcp-content.md) | Files from MCP content | Accepted |
| [0066](0066-sources.md) | Sources: any MCP server's events carry the owner's own messages, by a setup the owner confirms | Accepted; amended by 0068 |
| [0067](0067-no-home-surface-and-no-typed-decisions.md) | No Home surface and no typed decisions | Accepted |
| [0068](0068-events-use-their-standard-fields-only.md) | Events use their standard fields only | Accepted |
| [0070](0070-notices-and-files-leave-through-the-owners-tools.md) | Notices and files leave through the owner's own tools: Notify me via and file links | Accepted; amended by 0071 |
| [0071](0071-sink-delivery-rules-and-event-identity.md) | Sink delivery rules and exact event identity | Accepted |
