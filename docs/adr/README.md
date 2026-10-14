# Architecture decision records

One decision per file, numbered in order. A new decision that replaces an old one is a new ADR that says what it
supersedes; the old ADR moves to [archive/](archive/README.md) and is not edited again. The row below keeps the current
status; a partly replaced ADR stays here and names what replaced which part.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-runtime-and-auth-storage.md) | Native Pi runtime and identity storage | Accepted |
| [0002](0002-stages-and-provider.md) | Isolated stages and provider planes | Accepted; amended by 0059 |
| [0003](0003-resident-mcp-and-inbound-server.md) | The agent object owns MCP, holds its own authority, and serves /mcp | Accepted |
| [0004](0004-an-agent-per-user.md) | An agent per user, with gated sign-up | Accepted |
| [0005](0005-mcp-apps-host.md) | One live MCP App on a stage, told about its host, trusted for nothing | Accepted; its one live App superseded by 0020 |
| [0006](0006-servers-the-owner-adds.md) | Servers the owner adds are a trust boundary, not a configuration change | Accepted |
| [0007](0007-one-main-conversation.md) | One main conversation that never ends, with side threads and subagents | Accepted; amended by 0010, 0017, 0018 and 0032 |
| [0008](0008-skills-from-mcp-servers.md) | Skills come from MCP servers the owner turns them on for, and the agent drafts new ones for review | Accepted |
| [0009](0009-telegram-through-myagent.md) | Telegram through myagent | Accepted |
| [0010](0010-per-conversation-capabilities-and-thread-notes.md) | Per-conversation capabilities, and main learns the names of threads started with "+" | Accepted; its per-conversation switches superseded by 0040 |
| [0011](0011-mcp-events.md) | MCP Events consumer | Accepted |
| [0012](0012-routines.md) | Confirmed routines and isolated run threads | Accepted |
| [0014](0014-members-and-workspace-authority.md) | Members and workspace authority | Withdrawn |
| [0016](0016-workspace-layout-with-trellis.md) | Workspace layout with Trellis | Superseded by 0019, then 0036 |
| [0017](0017-conversation-tree-and-one-close.md) | A tree of conversations, threads from anywhere, one Close | Accepted |
| [0018](0018-subagents-nest-steer-and-close.md) | Subagents nest, steer and close | Accepted |
| [0019](0019-panes-for-everything.md) | Panes for everything | Superseded by 0036 |
| [0020](0020-durable-apps-one-iframe-per-instance.md) | Durable Apps, one iframe per instance | Accepted |
| [0021](0021-agent-apps.md) | Agent apps | Accepted |
| [0022](0022-owner-files-shell-and-r2.md) | The owner's files, in Shell's Workspace and R2 | Accepted |
| [0023](0023-chat-blocks-and-one-kit.md) | Chat blocks, one kit | Accepted |
| [0024](0024-observing-conversations.md) | Observing conversations | Accepted |
| [0025](0025-home-surface.md) | Home surface | Accepted; web presentation deferred |
| [0027](0027-typed-tools.md) | Typed tools and one `app_call` | Accepted |
| [0028](0028-mcp-call-approvals.md) | Owner approval for an exact MCP call | Accepted |
| [0029](0029-composer-commands-and-references.md) | Composer commands, references and helper execution | Accepted |
| [0030](0030-logical-chats-over-pi-sessions.md) | Logical chats over Pi sessions | Accepted |
| [0031](0031-typed-decisions-through-workers-ai.md) | Typed decisions through Workers AI | Accepted |
| [0032](0032-topics-and-per-topic-memory.md) | Topics and per-Topic memory | Accepted |
| [0033](0033-personas.md) | Personas, organize receipts and Delegate results | Accepted |
| [0034](0034-move-to-thread.md) | Start thread and Move to thread | Accepted |
| [0035](0035-cross-topic-retrieval.md) | Cross-Topic retrieval | Accepted |
| [0036](0036-slack-style-shell.md) | Slack-style shell | Accepted |
| [0037](0037-conversation-flows-and-failure-reporting.md) | Conversation flows and failure reporting | Accepted |
| [0038](0038-typed-owner-api-served-by-the-agent.md) | Typed owner API served by the agent | Accepted |
| [0039](0039-chat-markdown-through-streamdown.md) | Chat Markdown through Streamdown, and what a reply may load | Accepted |
| [0040](0040-topic-and-persona-setup.md) | Topic setup and Persona setup | Accepted |
| [0041](0041-connections-tell-me-hand-to.md) | Connections, Tell me and Hand to | Accepted |
| [0042](0042-mcp-2026-client.md) | MCP 2026 client: live tool lists, URL requests and step-up | Accepted |
| [0043](0043-outside-work-through-mcp-servers.md) | Outside work comes through MCP servers, and some servers are first-class | Accepted |
| [0044](0044-spending-rules-for-paid-tools.md) | Spending rules for paid tools | Accepted |
| [0046](0046-production-promotion-and-public-source.md) | Daily development, deliberate production promotion and public source | Accepted |
| [0048](0048-first-run-start.md) | First-run Start | Accepted |
| [0049](0049-prepaid-servers-topped-up-from-the-wallet.md) | Prepaid servers topped up from the Goblin Wallet | Accepted |
| [0052](0052-one-mysi-connection-and-a-shelf-that-needs-no-sign-in.md) | One mysi connection and a shelf that needs no sign-in | Accepted |
| [0053](0053-pinned-services-and-apps-with-a-chat-bar.md) | Pinned services and Apps with a chat bar | Accepted |
| [0055](0055-telegram-chats-route-to-topics.md) | Telegram chats route to Topics | Accepted |
| [0056](0056-goblin-wallet-leaves-goblin.md) | Goblin Wallet leaves goblin | Accepted |
| [0057](0057-goblin-pays-for-no-model-call.md) | goblin pays for no model call | Accepted |
| [0058](0058-no-plans-tokens-and-an-optional-cap.md) | No plans: access by sign-up, usage in tokens with an optional cap | Accepted |
| [0059](0059-bring-your-own-model-endpoint.md) | Bring your own model endpoint | Accepted |
| [0060](0060-suggested-access-from-tool-annotations.md) | Suggested access from tool annotations | Accepted |
