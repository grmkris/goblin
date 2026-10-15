# Per-call MCP approval

## Per-call MCP approval

The owner grants a tool under Connections, then can select **Ask first**. This local policy is independent of remote
annotations. Pi's `beforeTool` prepares an encrypted, immutable approval; `mcp_call` records a terminating approval
request. The chat card fetches the owner-bound record and shows its redacted arguments, including public
`operationKey` and asset fields. Approve once dispatches the original arguments; Refuse dispatches nothing.

The shared MCP manager enforces this policy for model, routine, subagent and App callers. Approval binds the endpoint,
grant version, arguments, caller, conversation, task and call id. Current resident authority and execution scope are
checked after connection waits and again at HTTP dispatch. A compare-and-set records dispatch intent once; automatic
OAuth retries cannot reuse it. Reconstruction marks an interrupted dispatch uncertain and never replays it. Routines
release their executing slot while waiting and resume the same run. Direct owner console calls are explicit owner
acts; autonomous App calls to ask-first tools are refused. See [ADR 0028](../adr/0028-mcp-call-approvals.md).

A tool that spends is a tool like any other ([ADR 0063](../adr/0063-mcp-first-no-server-specific-code.md)): goblin
reads no amount from a call's arguments and keeps no limit of its own. Ask first is how the owner controls one, and a
server's own limits stay its own. Every held call's card is the same: the exact arguments, Refuse and Approve once
(`components/approval-card.tsx`, `ApprovalDecision`). Only the model's calls in a conversation reach the hold step;
work goblin does on its own (agent apps, Source replies) is refused an ask-first tool.
