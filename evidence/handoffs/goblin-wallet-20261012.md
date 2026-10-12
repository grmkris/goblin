# Goblin Wallet overnight run, 12 October 2026

The plan is `~/.claude/plans/ok-map-it-out-floofy-crab.md` and the design record is
[ADR 0045](../../docs/adr/0045-agent-wallet.md). The run went from 04:40 to about 06:30 CEST; the conductor was a
Claude Opus session working with Sonnet and Opus lanes.

## What is live

Goblin Wallet is deployed at `https://wallet-dev.goblin.surf`. It uses mainnet chains, and its limits are capped by the
ledger and by Privy's policy. Below, **proven** means it ran on the deployment through a browser and goblin dev:

| Beat | State |
|---|---|
| Privy sign-in (email OTP) and agent wallet creation | **proven**: test owner `goblin-wallet-demo@myinbox.lol`, owner `0x76C7…5e94`, agent `0xD354…274F` |
| goblin connects over MCP OAuth (DCR, then the wallet's consent page, then a token) | **proven**: goblin dev shows Connected and lists all 16 tools grouped by their two Apps |
| `wallet_status` through goblin | **proven**: goblin's `WalletStatus` shape, four chains, limits per layer |
| The wallet's dashboard MCP App inside goblin's sandbox | **proven**: shots `.local/evidence/wallet/07–08` |
| Over-limit or new-recipient spend (beat 4) | **proven up to payment**: `transfer`, then the wallet's URL request, then goblin's "Finish a step" card, then the Approve page (frozen terms, the hash checked in the browser), then Approved and retry. The result is an honest `failed — nothing sent`, because the agent holds no funds |
| EIP-7702 upgrade on Base, the allowance, and paid x402/MPP calls | **waiting on funding**: treasury `0x7Ad36C62Aa4e8D1e49aCC0e69362E4eC6c19Ad50` and relay `0x253F4234cEfB26cBE26066AFb362d906DCf4E22F` are still empty |

Spike receipts are in `evidence/wallet/`:

- **S1**: Privy agent wallet. A payment over the cap is refused with `policy_violation`.
- **S2**: on Tempo Moderato, a 7702 upgrade and a period allowance. The redeem within the cap succeeded; the one over
  the cap **reverted on-chain**.
- **S3**: Privy signs Tempo type-118 transactions. **S3 policy** records the live 17-rule policy and the probes run
  against it.
- **S5**: Exa's live 402 offers x402 on Base and MPP on Tempo, and Privy signs the x402 payment.

## Morning steps (Kris)

1. **Fund the run's addresses.**
   - Treasury: about $20 USDC on Base and $10 USDC.e on Tempo.
   - Relay: ETH on Base, plus Arbitrum and Ethereum if those tracks matter.
   - Then send the test owner's account some USDC on Base, and the agent a little Base ETH for gas, from the treasury.
     The conductor can do this once the treasury is funded.
2. **Privy dashboard.**
   - Turn on Google if you want to sign in with Google.
   - Turn off "External wallets": an external wallet cannot take the DeleGator's 7702 upgrade.
   - Turn on embedded wallets "create on login" for new users. Our test owner was created through the API.
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

## Known gaps

- **Relay transactions are held in memory.** The relay persists the raw transaction in isolate memory only; that store
  belongs in a Durable Object table.
- **The first transfer is stuck as `uncertain`.** `wallet-demo-transfer-0001` happened before the classification fix,
  so its $0.01 reservation stays until it is reconciled.
- **No workerd integration test for the wallet yet.** All tests run against `node:sqlite` and fakes.
- **Not yet built:**
  - an owner route to list or decide `request_policy_change`;
  - the Tempo access-key layer, for which the fallback is the Privy policy plus the ledger;
  - the "Wallet" thread for the global entrypoint, for which the fallback is no conversation.
- **Leftover Privy objects.** The spike wallets (`SPIKE_TEMPO_*` in `.local/wallet-dev.env`) and their policy stay in
  the Privy app; they hold no funds.
