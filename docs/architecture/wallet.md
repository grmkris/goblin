# Goblin Wallet

## Goblin Wallet

Goblin Wallet (ADR 0045) is a second Worker beside goblin's, with its own sign-in, storage and stage
(`apps/wallet/alchemy.run.ts`, deployed by `scripts/wallet-stage.ts`; dev at `https://wallet-dev.goblin.surf`). It is an
MCP server any client can connect; goblin connects it as a first-class server.

- **`apps/wallet`** serves `/mcp` (`createMcpHandler`, MCP 2026 with stateless legacy), MCP OAuth (`/oauth/*`,
  `/.well-known/*`, ported from Sidequest), the owner API (`/api/*`, Privy bearer tokens) and the App views
  (`/views/*`, from the web app's build). A `WalletLedger` Durable Object per owner keeps the wallet limits, operations,
  reservations, approvals, address book and view state in SQLite; `WalletAuth` keeps OAuth clients, codes and tokens.
- **`apps/wallet-web`** is the owner's app (Privy sign-in, onboarding, activity, limits, connections, the consent and
  Approve pages) and builds the single-file MCP App views. Signed out, `/` is the wallet's public landing
  (`src/pages/landing`, on the marketing parts it shares with goblin's in `packages/ui/src/marketing`): an agent's
  payments meeting the owner's limits, played once, then the limit layers, gas in USDC, a subscription signed once and
  the MCP address, with Privy's Sign in. Every other path signed out keeps the plain sign-in.
- **`packages/wallet`** holds the contract (tool and route schemas, goblin's `WalletStatus` shape), the chain table,
  amounts in integer base units, the Privy client and agent signer, delegation encoders, UserOperations (`userop`, and
  the server-only `bundler` for Pimlico) and the rails (x402, MPP on Tempo, transfers, LI.FI swaps, Relay bridges).

A spend is an operation: the wallet freezes its terms, reserves them against the wallet limits in one SQLite
transaction, asks the owner through a URL request when a limit, recipient or service needs it, signs through the
agent signer (whose Privy policy refuses what it does not allow), pays, and records the receipt. On-chain, the owner's
account (EIP-7702 upgraded to MetaMask's DeleGator) grants the agent signer an `ERC20PeriodTransfer` allowance, so the
chain itself caps what the agent can draw per period.

Every EVM send is an ERC-4337 v0.7 UserOperation from a 7702-delegated address ([ADR
0050](../adr/0050-gas-in-usdc-through-useroperations.md)): Pimlico bundles it and its
ERC-20 paymaster takes the gas in USDC, approved in the batch for exactly the fee bound and refused above the chain's
ceiling. The agent sends only through `sendCalls` (`balances/agent-send.ts`): when it lacks what a batch spends plus the
gas, the batch first redeems exactly that from the allowance, and its first operation carries its 7702 authorization.
A payment keeps its `userOpHash`, and `operation_check` asks the bundler about it, because the bundle's own transaction
succeeds even when the operation inside it reverted. The owner's upgrade is their own operation, prepared and stored by
the Worker (`POST /api/onboarding/upgrade/prepare`), checked and signed in the browser, then sent (`POST
/api/onboarding/upgrade`). It needs USDC on that chain. The Privy policy allows the agent's calls only as
`eth_signUserOperation`.

A caller that makes the paid request itself uses `pay_challenge`, an App-only tool hidden from the model that goblin's
runtime calls for MPP inference. It hands over the service's 402 `WWW-Authenticate` value for an allow-listed payee
(`MPP_PAYEES`: an exact origin and its one recipient, no first-use approval); the wallet reserves the Tempo USDC.e
charge like any spend, signs it in Tempo's sponsored form (the service's fee payer pays the fee) and returns the
credential, never fetching. The operation stays uncertain, its amount held, until the caller reports the service's
`Payment-Receipt`, which settles it only when Tempo shows the agent's transfer under that challenge's memo. An agent
that holds less USDC.e than the charge is refused before anything is signed, as `insufficient_funds`: when the owner's
Base allowance can refill the float, with "Refilling from your Base allowance; try again in about a minute." and
`retryAfterSeconds`, otherwise naming its address and `add_funds`. A Tempo balance that cannot be read does not block
signing.

The wallet keeps that USDC.e, the Tempo float, topped up from the owner's Base allowance ([ADR
0051](../adr/0051-tempo-float-refilled-from-the-base-allowance.md)). Under $1 it bridges Base USDC to the agent's own
Tempo address through Relay, back to $3, as one UserOperation that redeems the shortfall and its gas. It is capped by
the allowance left this period and the owner's Base USDC, and skipped under $0.50. It runs on the owner's
`WalletLedger` alarm, one refill at a time (`rails/float.ts`, `ledger/float.ts`). Three things set the alarm: a
confirmed Base allowance (the seed), an MPP payment that leaves the float low, and a charge refused for funds. Each
refill is an activity row ("Moved $3.00 to Tempo for paid inference") that the spend windows do not count.

Paid inference and MPP services pay from the agent's own wallet on Tempo, in USDC.e. `wallet_status` names it as
`payFrom` (the address, and the USDC.e it holds when Tempo could be read) and `float` (its thresholds, whether a refill
is on its way, and whether the allowance refills it). Below about two paid calls (0.05 USDC.e), it says the
allowance keeps it topped up, or, only when the allowance cannot, where to send USDC.e and why. `add_funds` and the owner's `POST /api/deposits` give a one-off Relay deposit address
(`rails/deposit.ts`): ETH or USDC sent there on Base, Arbitrum or Ethereum arrives as USDC.e with the agent on Tempo, or,
for the owner's route, as ETH or USDC in the owner's account on Base. `add_funds_status` follows the address. Neither
signs nor spends; whoever sends pays. `wallet_open` (and `wallet_home`) with `focus: "add_funds"` opens the App on Add
funds. A rail's own refusal (testnets, no agent yet, a quote Relay refused) reaches the caller as `rail_refused` with its
words; only a rail that did not answer is `rail_unavailable`.

`wallet_status` counts as spendable only the funds the agent can reach: its own wallet's, and the owner's on a chain an
allowance (or Tempo access key) covers, under the tightest layer. A chain whose RPC fails is listed in `unread` with no
rows, never as a zero balance, and turns a "no" into "not verified". The dashboard App and the owner's Home share one
overview of that answer (`apps/wallet-web/src/views/overview-model.ts`, `views/overview.tsx`): what needs the owner
(an approval to review, an unknown outcome to check), what the agent can spend on which network and what holds it back,
recent work (each row opens to payment, delivery and evidence), the limits on that network, and balances by network.
The App opens with the address the agent pays from (`views/fund.tsx`: copy, a QR code, Tempo and its USDC.e) and Add
funds from any chain through `add_funds`, which follows the deposit until the balance shows it. It is open by itself as
"Fund this address" when nothing is held anywhere, and when the host opened the App with `focus: "add_funds"`.
Limits lists every limit one line each (`LimitLine`) with each layer's promise said once. The status also names the
owner's `site`, so the App opens Approve and the site through its host.

An operation whose outcome is unknown keeps its evidence: the transaction it sent, or an x402 payment's EIP-3009
authorization (signer, nonce, `validBefore`), as a payment without `settledAt`. `operation_check` (recommended to run
when needed) and the owner's `POST /api/operations/:id/check` read it once (`rails/check.ts`: the receipt, or USDC's
`authorizationState`) and settle it, fail it and release its hold, or leave it; a check never pays, and the receipt tool
answers only for a settled payment.
