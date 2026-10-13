# Goblin Wallet: video beats (draft, fill in after the live run)

Two videos are required (Colosseum): a pitch of 2–3 minutes, which judges watch early, and a product demo of 3 minutes at
most. Only mark a beat as recorded when it was captured live; anything that wasn't stays out of the video.

## Pitch (2:30)

1. **0:00–0:20, the problem.** "Agents can now buy things: search, data, other agents' work. But today you either give
   them a card with no limits, or you approve every cent."
2. **0:20–0:50, what goblin is.** goblin is a personal agent that lives in your own Cloudflare account. It's a Slack-like
   workspace with channels, threads, Personas and MCP servers, and each connection has its own permissions. Show the
   goblin shell with Mercator and Goblin Wallet in the sidebar.
3. **0:50–1:40, Goblin Wallet.** "An agent's wallet with limits you set, and every limit says who enforces it":
   - the chain (an ERC-7710 allowance on an EIP-7702 account; MetaMask's delegation contracts on Base, Ethereum,
     Arbitrum and Tempo);
   - Tempo's own access keys;
   - the signer's policy (Privy refuses anything outside it);
   - the wallet's ledger (per call, per hour, per week);
   - goblin's own spending rules.

   Show the dashboard App with its limit meters and layer badges.
4. **1:40–2:10, payments that already work on the open web.**
   - x402 on Base and MPP on Tempo; the same Exa search offers both.
   - Mercator for specialised jobs; the agent funds it on Tempo within its limits.
   - Every spend is an operation with frozen terms, a receipt, and approval when it crosses a limit.
5. **2:10–2:30, why now, and who it's for.** "MCP Apps make the wallet a first-class part of the agent's workspace, and
   it works in any MCP client. Goblin: a personal agent you control, with the tools and the budget to get things done."

## Demo (≤ 3:00); every beat is a live recording with transaction hashes on screen

1. **Sign in** (0:00–0:25). Sign in at wallet-dev.goblin.surf with Google, which creates the agent wallet. "Upgrade your
   account on Base": the Privy prompt, then the relay transaction on Basescan.
2. **Allowance** (0:25–0:45). "Give your agent 20 USDC an hour." The signed typed data is shown in plain words; the
   Limits page shows the on-chain layer.
3. **Connect goblin** (0:45–1:05). In goblin: Connections, then Goblin Wallet (first-class), then Connect, then the
   consent page, then Allow recommended. **Wallet** appears in the sidebar and opens the dashboard App.
4. **A paid search within the limit** (1:05–1:35). "Search what's new on Tempo today." goblin calls `paid_fetch`:
   Exa over x402 on Base costs $0.007, and a receipt App appears in the thread with the Basescan link.
5. **Over the limit** (1:35–2:05). The agent tries a bigger spend. goblin shows the URL-request card, which opens the
   wallet's Approve page with the exact amount, the limit it crosses, and its layer. Approve, the call retries, and a
   receipt appears.
6. **Fund Mercator on Tempo** (2:05–2:35). Mercator's status reports it is short of funds. The agent calls the wallet's
   `transfer` of USDC.e on Tempo to Mercator's address: first use asks for approval, then the job runs. Show the Tempo
   explorer.
7. **The chain says no** (2:35–2:50). An over-allowance redemption reverts on-chain:
   `ERC20PeriodTransferEnforcer:transfer-amount-exceeded`. Spike S2 recorded this on the Tempo testnet; re-record it on
   Base if possible.
8. **Revoke** (2:50–3:00). Stop all agent access, and the next call is refused.

## Proof to show on screen or in the README
- Transaction hashes for each beat (Basescan / Tempo explorer).
- The spike results (S1, S2, S3, S5), summarised in words; the receipts themselves stay private.
- The ADR 0045 authority diagram (the five layers).
