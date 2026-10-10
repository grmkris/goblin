# Web

Read the root instructions first. Owns TanStack Start, the conversation stream client and the MCP Apps host. No
server secrets reach browser code. Reconnect through a fresh Pi snapshot. Sandbox Apps and validate message
origin/source. Use the local shadcn UI package and keep all runtime calls behind the authenticated API.

## Data layer

Server data goes through the typed API and TanStack Query, and the workspace feed writes into the same cache. The
dialect (the clients, `<feature>Keys` and factories, mutations through `context.client`, `useSuspenseQuery` inside
`OwnerGate`, loaders through `primeOwnerRead`, the workspace slices, failures and their reference, tests) is
[docs/agents/ui.md](../../docs/agents/ui.md).
