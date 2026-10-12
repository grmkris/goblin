# Wallet web

Read the root instructions first. `@goblin/wallet-web` is the Goblin Wallet browser app: a Vite and React SPA (the owner
console) and, later, the single-file MCP App views in `src/views/`. It is built to `dist/` and served as static assets
by `@goblin/wallet-worker`. It may import `@goblin/wallet` and `@goblin/ui` only, and never the server modules of
`@goblin/wallet` (`privy`, `signer`, `x402`, `tempo`, `lifi`, `bridge`, `bundler`): `tools/graph.ts` forbids it, because
server signing and Privy app credentials never enter the browser bundle.

## Checks

- `bun run --cwd apps/wallet-web typecheck`, `... build`, `... effect:check`.
- Use the shared shadcn components from `@goblin/ui`; theme tokens, no raw colours or inline styles.

## Pages

- The console (Home, Activity, Limits, Connections, Add funds) opens whether or not setup is finished; nothing gates
  its navigation. `/setup`, `/consent` and `/approve/:id` are focus pages without it. Routes are `app/routes.ts`; a
  trailing slash names the same page.
- Setup lives in `pages/setup/*` and is shared by `/setup` and `/consent`: the agent wallet is created for the owner,
  then Add funds, then Turn on spending, each resuming from `/api/me` and `/api/status`. What a screen decides without
  the network is a pure model (`model.ts`, `consent-model.ts`, `return.ts`) with its tests.
- `?fixtures` (busy wallet), `?fixtures=fresh` (just signed in, goblin asking to connect), `?fixtures=funded` (USDC on
  Base, spending off) and `?fixtures=expired` (consent ran out) run the app on fixtures, for previews: Privy sign-in does
  not work on localhost.

## Test floor

- Vitest on the pure models (setup, consent, routes, deposits, the views' display models); no DOM tests.

## Landmines

- The Privy app id is not a build variable. Fetch `GET /api/config` at runtime; there is no `VITE_*` setting.
- The Worker answers `/mcp*`, `/api/*`, `/oauth/*`, `/.well-known/*`, `/health` and `/views/*` before assets; any
  other path falls back to `index.html`.
- Time the production build when you add dependencies (`bun run --cwd apps/wallet-web build`); CI allows 30 minutes
  for the whole check.
