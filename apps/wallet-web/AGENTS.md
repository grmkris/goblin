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

- Signed out, `/` is the public landing (`pages/landing`, built on `@goblin/ui`'s marketing parts, which this app never
  edits): the hero's stream of payments (`stream-model.ts`, played once, settled at once under reduced motion), then
  the sections, each claim checked against the wallet's code and ADRs. Every other path signed out, and a stalled
  sign-in anywhere, keeps the plain sign-in (`app/front-door.ts`). Signed in, `/` is Home.
- The console (Home, Activity, Limits, Connections, Add funds) opens whether or not setup is finished; nothing gates
  its navigation. `/setup`, `/consent`, `/approve/:id` and `/subscribe/:id` (a merchant's subscription to sign once,
  ADR 0054) are focus pages without it. Routes are `app/routes.ts`; a trailing slash names the same page.
- Setup lives in `pages/setup/*` and is shared by `/setup` and `/consent`: the agent wallet is created for the owner,
  then Add funds, then Turn on spending, each resuming from `/api/me` and `/api/status`. What a screen decides without
  the network is a pure model (`model.ts`, `consent-model.ts`, `return.ts`) with its tests.
- `?fixtures` (busy wallet), `?fixtures=fresh` (just signed in, goblin asking to connect), `?fixtures=funded` (USDC on
  Base, spending off), `?fixtures=expired` (consent ran out) and `?fixtures=signed-out` (the landing; Sign in opens
  the busy wallet) run the app on fixtures, for previews: Privy sign-in does not work on localhost.
  `bun apps/wallet-web/test/ui-landing.ts` screenshots the landing on them. goblin Pro's sign sheet has a request per billing, `/subscribe/sub_5ab0…5ab0?fixtures`
  (every 30 days) and `/subscribe/sub_0da7…0da7?fixtures` (the day pass); a busy wallet runs both.

## Test floor

- Vitest on the pure models (setup, consent, routes, deposits, the views' display models); no DOM tests.

## Landmines

- The Privy app id is not a build variable. Fetch `GET /api/config` at runtime; there is no `VITE_*` setting.
- The Worker answers `/mcp*`, `/api/*`, `/oauth/*`, `/.well-known/*`, `/health` and `/views/*` before assets; any
  other path falls back to `index.html`.
- Time the production build when you add dependencies (`bun run --cwd apps/wallet-web build`); CI allows 30 minutes
  for the whole check.
