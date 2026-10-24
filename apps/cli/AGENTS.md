# CLI

Read the root instructions first. `goblin` is a terminal MCP client of the deployed Worker's `/mcp`, with inspection
(ADR 0024): it signs in with OAuth like any MCP client, takes its commands from the server's `tools/list`, and never
imports the runtime. `goblin follow <chat>` reads a chat's stream with the same sign-in's token as its bearer on the
workspace's path (ADR 0116). Settings come from flags and `Config` (environment), credentials live in a mode-600 file, and
Cloudflare credentials stay in the shell for `goblin logs`, `goblin lookup` and `goblin stats` (Analytics Engine SQL,
which needs Account Analytics read) and are never printed.
