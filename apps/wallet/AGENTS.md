# Wallet worker

Read the root instructions first. `@goblin/wallet-worker` is the Goblin Wallet Cloudflare Worker: the owner API, the
inbound MCP server, OAuth, the per-owner `WalletLedger` Durable Object, the `WalletAuth` singleton and `WalletRelay`
(one per network chain id and relay address: the only signer of relay transactions, with their stored bytes, nonces
and daily upgrade quota). It serves the `@goblin/wallet-web` build as static assets and `/views/*.html` through
`env.ASSETS`. It may import `@goblin/wallet` only. Infrastructure is `alchemy.run.ts` (Stack `goblin-wallet`); it is
deployed by `bun run deploy:wallet-dev` (`scripts/wallet-stage.ts`), never by `scripts/stage.ts`.

## Checks

- `bun run --cwd apps/wallet typecheck`, `... test`, `... effect:check`.
- Declare a binding in `src/env.ts` and `alchemy.run.ts` together.

## Test floor

- Unit tests call `worker.fetch` with a hand-built env. There is no workerd integration test yet; the first lane that
  adds a Durable Object behavior adds one, and this line changes with it.
- Money paths get table tests in `@goblin/wallet`, not here.
- `WALLET_LIVE` selects mainnets or their testnets for every rail (`RailsDeps.live`, `rpcFromEnv`, the relay); on
  testnets Tempo transfers, swaps and bridges are refused because their packages speak mainnet only.

## Landmines

- No `node:*` imports and no `process.env` in `src`; use WebCrypto and the `env` binding.
- Secrets (`PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_KEY`, `RELAY_PRIVATE_KEY`) are redacted Alchemy bindings: never
  log, return or persist them. `GET /api/config` serves the public app id only.
- Lint limits: 80 lines per function, cognitive complexity 15, 5 parameters, a `// SAFETY:` on every assertion, one
  MCP tool per file.
- Only `src/runtime.ts` (when it exists) calls `Effect.runPromise`.
- The Durable Object classes are exported from `src/worker.ts`; renaming one needs an Alchemy migration.
