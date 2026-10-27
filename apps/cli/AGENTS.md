# CLI

Read the root instructions first. `goblin` is a terminal MCP client of the deployed Worker's `/mcp`, with inspection
(ADR 0024): it signs in with OAuth like any MCP client, takes its commands from the server's `tools/list`, and never
imports the runtime. `goblin follow <chat>` reads a chat's stream with the same sign-in's token as its bearer on the
workspace's path (ADR 0116). `goblin token` prints an installed app's access token (ADR 0118) from `GOBLIN_CLIENT_ID`
(or `--client-id`) and `GOBLIN_CLIENT_SECRET`, which has no flag, so a secret never reaches shell history. Settings come from flags and `Config` (environment), and credentials live in a mode-600 file.
It reads goblin only: Cloudflare's own data (Workers Observability, Analytics Engine) is read through Cloudflare's MCP
(ADR 0124).
