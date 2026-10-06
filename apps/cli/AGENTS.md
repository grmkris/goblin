# CLI

Read the root instructions first. `goblin` is a terminal MCP client of the deployed Worker's inspection endpoints
(ADR 0024): it signs in with OAuth like any MCP client, takes its commands from the server's `tools/list`, and never
imports the runtime. Settings come from flags and `Config` (environment), credentials live in a mode-600 file, and
Cloudflare credentials stay in the shell for `goblin logs`.
