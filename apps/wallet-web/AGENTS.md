# Wallet web

Read the root instructions first. `@goblin/wallet-web` is the Goblin Wallet browser app: a Vite and React SPA (the owner
console) and, later, the single-file MCP App views in `src/views/`. It is built to `dist/` and served as static assets
by `@goblin/wallet-worker`. It may import `@goblin/wallet` and `@goblin/ui` only, and never the server modules of
`@goblin/wallet` (`privy`, `signer`, `x402`, `tempo`, `lifi`, `bridge`, `bundler`): `tools/graph.ts` forbids it, because
server signing and Privy app credentials never enter the browser bundle.

## Checks

- `bun run --cwd apps/wallet-web typecheck`, `... build`, `... effect:check`.
- Use the shared shadcn components from `@goblin/ui`; theme tokens, no raw colours or inline styles.

## Test floor

- No test script yet: vitest with no files exits 1. The first component with behavior adds a test and the script.

## Landmines

- The Privy app id is not a build variable. Fetch `GET /api/config` at runtime; there is no `VITE_*` setting.
- The Worker answers `/mcp*`, `/api/*`, `/oauth/*`, `/.well-known/*`, `/health` and `/views/*` before assets; any
  other path falls back to `index.html`.
- Time the production build when you add dependencies (`bun run --cwd apps/wallet-web build`); CI allows 30 minutes
  for the whole check.
