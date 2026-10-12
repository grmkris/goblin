# Wallet package

Read the root instructions first. `@goblin/wallet` is the shared, runtime-independent library of Goblin Wallet:
chain facts, amounts, the contract between the Worker and its clients, and the rails (Privy, signer, relay, x402,
Tempo, LI.FI, bridge, balances). It imports no workspace and runs in Workers, the browser and tests. No Bun, `node:*`
or Cloudflare APIs, no `process.env`; use WebCrypto. Secret-bearing modules (`privy`, `signer`, `relay`, `x402`,
`tempo`, `lifi`, `bridge`) are closed to the browser by `tools/graph.ts`.

Each module is a subpath export (`@goblin/wallet/<module>`) with its own `src/<module>/index.ts`, so lanes never share
a barrel. Plain async code with Schema at boundaries; Effect lives in `apps/wallet`.

## Checks and test floor

- `bun run --cwd packages/wallet typecheck`, `... test`, `... effect:check`.
- Pure functions (amounts, chains, signing payloads) get table tests. A test script that finds no tests fails vitest,
  so a module gets tests as it gets code.

## Landmines

- Money is `bigint` base units or a decimal string. `src/amounts` rejects numbers, exponents, signs and excess
  precision; never `Number()` an amount.
- Tempo's tokens are TIP-20 and have no `version()` or EIP-3009, so x402 `exact` does not run there (`eip3009: null`).
- Circle's testnet USDC reports the EIP-712 name `USDC`, the mainnet and Arbitrum Sepolia ones `USD Coin`.
  Signing with the wrong name yields an invalid authorization, not an error.

## Verified (read-only, 2026-10-12, `cast call` / `cast code` against the public RPCs in `src/chains`)

- USDC `name()`, `version()` ("2") and `decimals()` (6) on Base, Ethereum, Arbitrum, Base Sepolia, Sepolia and Arbitrum
  Sepolia; the names are in the table.
- Tempo mainnet `0x20C0…8b50` is symbol `USDC.e`, name "Bridged USDC (Stargate)", 6 decimals, no `version()`.
  Tempo Moderato has no USDC; `0x20c0…0000` is `pathUSD` (6 decimals) on both Tempo networks.
- All ten Delegation Framework v1.3.0 contracts (manager, delegator, eight enforcers) have code on all eight chains,
  Tempo and Moderato included.
- Not verified: the explorer URLs (spot-checked by eye only) and the testnet USDC addresses' faucet availability.
