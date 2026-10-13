# Goblin Wallet overnight run, 12 October 2026

The plan is the owner's private plan file and the design record is
[ADR 0045](../../docs/adr/0045-agent-wallet.md). The run went from 04:40 to about 06:30 CEST; the conductor was a
Claude Opus session working with Sonnet and Opus lanes.

## What is live

Goblin Wallet is deployed at `https://wallet-dev.goblin.surf`. It uses mainnet chains, and its limits are capped by the
ledger and by Privy's policy. Below, **proven** means it ran on the deployment through a browser and goblin dev:

| Beat | State |
|---|---|
| Privy sign-in (email OTP) and agent wallet creation | **proven**: a demo test owner signed in, with its owner wallet and agent wallet created |
| goblin connects over MCP OAuth (DCR, then the wallet's consent page, then a token) | **proven**: goblin dev shows Connected and lists all 16 tools grouped by their two Apps |
| `wallet_status` through goblin | **proven**: goblin's `WalletStatus` shape, four chains, limits per layer |
| The wallet's dashboard MCP App inside goblin's sandbox | **proven**: shots `.local/evidence/wallet/07–08` |
| Over-limit or new-recipient spend (beat 4) | **proven up to payment**: `transfer`, then the wallet's URL request, then goblin's "Finish a step" card, then the Approve page (frozen terms, the hash checked in the browser), then Approved and retry. The result is an honest `failed — nothing sent`, because the agent holds no funds |
| EIP-7702 upgrade on Base and the $20/hour allowance (beat 1) | **proven on mainnet, 12:00**: the owner was funded with ETH only; a Relay deposit address swapped it to USDC; the relay (funded by the owner) sent the upgrade |
| A paid Exa search over x402, topped up from the allowance (beat 3) | **proven on mainnet**: settlement `0xc09ca95d…b0fd`, receipt App in goblin |
| A new recipient approved, then paid (beat 4) | **proven on mainnet**: 1 USDC, `0xe4219e53…e3dc` |
| Mercator short: bridge Base → Tempo, then pay Mercator (beat 5) | **proven on mainnet**: Relay deposit `0x2dce0489…3e7b`; 1.5 USDC.e to Mercator `0xf144e54d…2add`; Mercator went 0.55 → 2.05 USDC.e |

The spike receipts were kept privately, not in the repository:

- **S1**: Privy agent wallet. A payment over the cap is refused with `policy_violation`.
- **S2**: on Tempo Moderato, a 7702 upgrade and a period allowance. The redeem within the cap succeeded; the one over
  the cap **reverted on-chain**.
- **S3**: Privy signs Tempo type-118 transactions. **S3 policy** records the live 17-rule policy and the probes run
  against it.
- **S5**: Exa's live 402 offers x402 on Base and MPP on Tempo, and Privy signs the x402 payment.

## The night (17:30–19:40): gas in USDC through UserOperations (ADR 0050)

Kris chose the long-term pattern: no account of the wallet ever needs ETH.

- **Built on main** (`e6d1348f`..`61e681b5`), deployed to wallet-dev and wallet prod:
  - Every EVM send is a Pimlico UserOperation, its gas paid in USDC by the ERC-20 paymaster.
  - The agent acts only through `sendCalls`. When it is short, the same batch redeems the shortfall plus the gas.
  - The owner's upgrade is their own UserOperation, prepared and confirmed like the allowance and signed in the browser.
  - The relay is deleted. Its accounts' ETH was swept to the run treasury.
  - The Privy policy now allows the agent's calls only as `eth_signUserOperation` (24 rules).
- **Proven on Base mainnet, zero ETH throughout:**

  | Path | Gas (USDC) | Proof |
  | --- | --- | --- |
  | A fresh owner's upgrade, signed through Privy in the browser | 0.0038 | — |
  | An agent transfer with its top-up in the same operation | 0.0073 | `0x5725377f…5d55` |
  | A fresh agent's first operation (its 7702 authorization and a redeem), then x402 | 0.0098 | `0xe1662494…2058` |

  On prod, a demo account's agent upgraded itself through its first operation and paid two searches:
  `0x45109aa6…933b`, `0xc772effb…da7d`.
- **Privy finding.** Its React SDK drops `authorization_list` from type-4 sends, which is why it answered 500. A
  self-sent upgrade works once that is patched (`0x13e75ea3…1f1c`). The report draft is
  `.local/privy-7702-authorization-list-bug.md`. goblin does not carry the patch, and Sidequest will adopt it with
  `bun patch`.
- **Slip, disclosed and fixed.** A spike edited the shared bun cache's copy of react-auth in place from 17:58 to 18:24.
  It was restored byte for byte, and Sidequest confirmed no impact.
- **Ops.**
  - `PIMLICO_API_KEY` is in `.local/wallet-*.env`, and the `RELAY_*` lines are gone.
  - The Codex publication pane is asked to re-upload `GOBLIN_WALLET_PROD_ENV`.

## The evening (16:00–17:30)

- **Recording on prod (goblin.surf 8fd49a6b, wallet.goblin.surf), as a demo account.** The clips are in
  `.local/evidence/wallet/clips/`, with notes in `CLIPS.md`:
  - onboarding (01a–c);
  - paid inference over MPP plus a paid Exa search over x402 (02-04): Base `0xabe9…85100`, about $0.021 of USDC.e per
    model call on Tempo;
  - first-use approval and 0.5 USDC.e to Kris's Mercator address (03): Tempo `0x0ea8fe76…8b88`.
- **The prod `paid_fetch` failures** ("The chain did not answer before signing") predate the 16:20 redeploy of cff883c8,
  which names the failing method. A direct MCP call then paid (`0xf4da4508…c870`), and so did one through goblin.surf.
- **goblin bug, owned by the inference session:** for a first-use `transfer`, the wallet's URL request showed "may have
  run" in goblin's chat instead of the approval link. The Approve page and a retry delivered.
- **Funding from inside the App (asked by Kris via the inference session):**
  - Commits b39e5501..057985d0. Relay deposit addresses deliver USDC.e on Tempo to the agent.
  - New: `add_funds` and `add_funds_status`, `payFrom` in `wallet_status`, `wallet_open {focus:"add_funds"}`.
  - `pay_challenge` answers `insufficient_funds` before signing; a rail's own refusal reaches the caller as `rail_refused`.
  - The App's "Pays from" card shows the address, a QR code and Add funds.
  - **Proven on wallet-dev in dev goblin:** 0.5 USDC on Base (`0xfa2ba728…9e21`), then 0.475952 USDC.e with the agent
    on Tempo (`0x51821855…57de`); the App said Arrived.
  - An App frame cannot submit a `<form>` (no `allow-forms`), so Add funds acts on click and Enter.
  - goblin needs the two tools in the wallet profile's recommended grants. Until then, the first App call that raises
    goblin's grant prompt fails with "processing response error".
- **Money moved:** the run treasury's last 0.5 USDC on Base went to the dev agent's Tempo balance through that deposit.

## The afternoon (12:30–14:00)

Decided with Kris in a grill session:

- The wallet workspaces are MIT, and goblin stays PolyForm Noncommercial.
- The README carries the wallet with explorer links and screenshots, and a corrected disclosure: everything was built in
  the contest window.
- The wallet joins Promote; the Codex publication pane is building `wallet_release.py`.
- goblin opens sign-up with a 50 Credits/day free plan, shipped by the Mercator session.
- Paid inference through the wallet waits until after the deadline (`docs/next.md`).

Built and proven on mainnet:

- **Add funds from any chain.** `POST /api/deposits` returns a one-off Relay deposit address, and
  `GET /api/deposits/:address` follows it by address. Relay's keyless status API rate-limits, so `unknown` is a state
  and the card also watches the balance. Live: 0.0004 ETH sent to the address (`0x7deaa692…61e6`) arrived as 0.99 USDC.
  Onboarding now starts with "Fund your account".
- **The UX plan's wallet slices.** One display model (integer micro-dollars; spendable scoped to what the agent can
  execute; unknown is never zero), a shared overview for Home and the App, and payment shown apart from delivery.
- **Beat 6.** The swap of 1 USDC to ETH through LI.FI went through on the second try (`0x8670f3d1…45fc`); the first
  reverted in simulation because a node behind the fresh approval was asked. Swaps and bridges now wait until the
  approval is visible. Revoke: the owner disconnected goblin in the wallet, goblin's next call was refused and it asked
  to sign in again, and reconnecting restored it with the grants intact.

Still open:

- **Public RPCs remain the weak point.** Tenderly's gateway rate-limited this box once. A keyed RPC for prod would
  remove the risk.
- **Arbitrum and Ethereum upgrades are not run.** The relay holds no ETH there.

## The live pass (11:00–12:20)

Kris funded the test owner with 0.012 ETH on Base. The README links the main transactions.

- **One address, any chain.** The owner's address is the same on every EVM chain. A Relay deposit address converts
  whatever arrives (ETH, USDC; Arbitrum, Ethereum, Base) to the asset needed on Base in about two seconds, for a few
  cents. EVM sources need no API key; Solana needs a Relay key.
- **The owner sends its own upgrade: no.** Privy's embedded wallet answers HTTP 500 to a type-4 transaction, through
  both its send hook and its provider; plain sends work. So the relay stays for the upgrade, and the owner can fund it.
- **Fixed during the pass:**
  - publicnode answers 403 to a receipt it has not seen, and mainnet.base.org and drpc rate-limit Cloudflare.
    wallet-dev and prod now use Tenderly's public gateway.
  - The facilitator and our RPC both lagged a fresh top-up. x402 now waits two blocks after one, and every top-up
    waits until the RPC shows the new balance.
  - Swaps and bridges never drew on the allowance, and a bridge signed an approval from an empty wallet.
  - Home and the dashboard App added ETH to the dollars.
- **wallet.goblin.surf (prod)** is deployed for goblin prod `9ca847e2`. It has its own relay, funded with 0.001 ETH.
- **goblin bug, not fixed here.** In chat, Send does nothing while several "Sharing from <App>" chips are stacked over
  the composer; removing them lets it send.
- **Left over.** `wallet-beat3-exa-0001` stays `unknown`, holding $0.007. Its credential can no longer settle, but
  there is no reconcile route yet.

## Where it stands (07:40)

- goblin `main` is at `bb091a24`, and goblin dev is released at `9ca847e2` (acceptance authenticated). Everything after
  `9ca847e2` touches the wallet only.
- wallet-dev runs `226b9eb0`, which adds:
  - the review fixes;
  - the `WalletRelay` Durable Object;
  - binding fee bounds;
  - the owner's view of the agent's `request_policy_change` asks, on the Limits page.
- Two probes ran against live services, signing nothing:
  - Privy accepts the fee fields (it signed and failed to broadcast at zero balance).
  - Relay quotes 2 USDC on Base → 1.979 USDC.e on Tempo, and LI.FI quotes USDC → ETH on Base.
- The funded run and its capped funding moves were scripted in a scratch directory on the dev box.

## Morning steps (Kris)

1. **Funding: done.** Kris sent 0.012 ETH to the test owner at about 11:05; beats 1–5 ran from it. For Arbitrum and
   Ethereum, fund the relay on those chains.
2. **Privy dashboard.** Turn on Google if you want to sign in with Google. The run turned "External wallets" off
   through the shared tab; the app config already creates embedded wallets on login.
3. **Decide on prod with the Mercator session.** The choice is 6c249c18, which has no wallet, or the wallet integration
   sha. The prod shelf entry already points at `wallet.goblin.surf`, which does not exist yet.
4. **Before submitting:**
   - make `grmkris/goblin` public once the secrets audit is clean;
   - record the two videos (`evidence/handoffs/goblin-wallet-video-beats-20261012.md`).

## Found and fixed during the run

- **Asset routing.**
  - App views fetched at `/views/<name>.html` came back 307; the Worker now reads `/views/<name>`.
  - The SPA routes (`/consent`, `/approve/…`) did not get the assets fallback; the Worker now serves the app shell to a
    browser asking for HTML.
- **Consent page "You are signed out" on first load.** Right after the OAuth redirect, Privy returns no token for a
  moment, so the client now retries a few times.
- **Public RPCs answer 429 to Cloudflare's shared egress.**
  - The client retries twice.
  - A read that fails before signing now fails the transfer instead of marking it uncertain.
  - wallet-dev now uses `WALLET_RPC_URLS` (publicnode for Base, Ethereum and Arbitrum).
- **The shell exports Sidequest's `PRIVY_*`, and `bun --env-file` does not override it.** One lane made a read-only
  call to Sidequest's Privy app, which listed its users. Nothing was written. Scripts now read
  `.local/wallet-dev.env` directly, and `scripts/wallet-stage.ts` scrubs `PRIVY_*`.
- **Privy refuses `fee_payer: true` on Tempo.** MPP payments use the form where the agent pays its own fee in USDC.e,
  and x402 on Base stays Exa's main rail.

## Security review and fixes

At about 06:40 a Codex `gpt-6-astra` pass reviewed the three wallet workspaces read-only and reported ten money-path
findings, seven of them high. Two Claude Opus lanes fixed all ten by 07:00, and the conductor added two follow-ups;
wallet-dev was redeployed with them at 07:06.

| # | Finding | Fix |
|---|---|---|
| 1 | Two calls with one operation id and different arguments could both execute | `begin` conflict is rejected (`operation_id_reused`) |
| 2 | An owner could drain the relay with future-nonce authorizations | The authorization nonce must equal the owner's account nonce; quota of 3 per owner and 30 per chain per day; `upgraded` only once the code delegates |
| 3 | Gas bypassed the ledger (zero and self transfers, no fee ceiling) | Zero and self transfers refused; per-chain fee ceilings, signed as the transaction's exact fee bounds; Tempo at $0.05 |
| 4 | A paid response that broke mid-read erased the settlement | Settlement kept, delivery reported failed; the body is bounded while streaming |
| 5 | A 402 after the credential left counted as "nothing paid" | It is `unknown`, so the reservation stays |
| 6 | Swap and bridge calldata were not checked against the quote | LI.FI and Relay calldata decoded and checked against the request |
| 7 | Relay nonces and signed bytes lived in isolate memory | The `WalletRelay` Durable Object, one per chain and relay address |
| 8 | A stale reservation could sign after its grant expired | The reserved-to-signing step re-checks grant, quote and current limits |
| 9 | `WALLET_LIVE=0` did not govern the relay | Every rail follows `WALLET_LIVE`; paid services refuse on testnets |
| 10 | A quote retry after expiry hid the earlier payment | The operation is looked up before the quote |

Still open from the review:

- **Fees are not reserved in the ledger.** The ceilings bound what one signature can burn, but the dollar windows count
  principal only, and failed-transaction gas is not budgeted.
- **Relay recipient.** Relay binds the destination recipient through an order id the wallet cannot decode, so it is
  checked against the quote's details only.
- **Relay keys per deployment.** Dev and prod need separate `RELAY_PRIVATE_KEY`s, since each has its own `WalletRelay`.

## Known gaps

- **The first transfer is stuck as `uncertain`.** `wallet-demo-transfer-0001` happened before the classification fix,
  so its $0.01 reservation stays until it is reconciled.
- **No workerd integration test for the wallet yet.** All tests, `WalletRelay`'s included, run against `node:sqlite`
  and fakes.
- **Not yet built:**
  - the Tempo access-key layer, for which the fallback is the Privy policy plus the ledger;
  - the "Wallet" thread for the global entrypoint, for which the fallback is no conversation.
- **Leftover Privy objects.** The spike wallets (`SPIKE_TEMPO_*` in `.local/wallet-dev.env`) and their policy stay in
  the Privy app; they hold no funds.
