# Plans and payments

## Plans and payments

The account boundary in auth D1 is independent of the agent's Pi store (ADR 0015). `billing/` owns customers,
subscriptions, checkout rate accounting and the verified webhook inbox through Drizzle `app_billing_*` tables. Better
Auth continues to own identity and inbound OAuth. No billing operation writes Pi or Agents tables.

`GET /api/billing/state`, `POST /api/billing/checkout` and `POST /api/billing/portal` (the account API's `billing`
group, answered in the Worker) authenticate the owner without resolving an Agent.
Product and checkout metadata are selected server-side. Checkout and the return page grant no
access: `POST /hooks/dodo` verifies Standard Webhooks HMAC over the raw body, checks freshness and stores the first
body under `webhook-id` before responding 2xx. A leased background run updates the subscription; an hourly Worker cron
retries unfinished receipts and reads stale subscriptions back from Dodo. Provider timestamps prevent old events
from overwriting newer states. This is durable idempotent reconciliation, not exactly-once provider effects.

The Worker's edge reads no plan (ADR 0054, amended 2026-10-13): a signed-in owner reaches their own Agent through the
owner API, and the account API answers any signed-in account, so Start can connect the Goblin Wallet and choose Pro
before there is a plan. Inbound MCP and the user-bound hooks reach the Agent through its internal API, whose gate
checks the plan the Agent keeps (402 without one). Inside the Agent, what needs Pro checks its `Entitlements` service:
a turn at `Budget.admit` (the composer, Telegram, a Persona, an inbound client's ask), routines and their notices'
Telegram copies, Events, a decision on a held call, a Persona's reply, app powers, the internal gate and the budget
every background model call checks. Without a plan each answers `SubscriptionRequired` with `feature: 'chat'`.
`Entitlements` keeps an active plan for 60 seconds (`cachedPolicy` in `billing/gates.ts`, ADR 0015 amended); a plan
that is not active, or a read that failed, is not kept, and a day pass's payment drops the kept plan when it ends. No
lifecycle lock is held around the D1 read. A cancelled plan can keep the Agent's own background work, and its hooks
and inbound clients, going for up to a minute. Active or cancelled subscriptions remain usable only through their
recorded paid period. Failed renewals use the provider's
grace end or three days after the period end; missing dates fail closed. Existing users at the billing migration get a
dev-only override, which grants nothing on prod. Operator overrides may supply their own allowance.

Each Agent's usage ledger still records its owner's UTC-day spend, while the allowance now comes from that account's
plan (the catalog's Credits a day for the way it pays, 800 by default; none without a plan; ADR 0026), at the Credit
rates the stage configures; the defaults are Alibaba's example rates and need operator review against the plan's real
billing.

**Pro from the Goblin Wallet (ADR 0054).** goblin Pro is paid from the Goblin Wallet as a subscription the owner signs
once: an ERC-7710 delegation to goblin's collector that the chain holds to USDC transfers into the collector only, at
most the price a period, for 12 months. It is paid by a **day pass** ($1 for each UTC day the owner uses goblin, its
periods UTC days from the midnight that begins the signing day) or **monthly** ($15 every 30 days, 12 payments). The
prices and each one's daily Credits are the deployment's setting, `GOBLIN_PLAN_CATALOG` over the defaults in
`billing/plans.ts`, listed in `BillingState.catalog`. goblin is a merchant of the wallet (`billing/wallet.ts`, the
`WalletMerchant` service, server to server with the merchant key), asking for `plan: 'pro'` and the `billing`.
`POST /api/billing/wallet/start` (`{ plan: 'day' | 'month', return? }`) asks the wallet for the subscription and
answers where to sign it; a day pass may start monthly, any other start while Pro is on is `already_subscribed`. The
wallet sends the owner back to `/subscribe/success`, whose `POST /api/billing/wallet/confirm`:
- monthly: takes the current period's payment once (operation id `<billing>:<subscription>:<period>`) and answers its
  receipt; its first payment supersedes a day pass, which is not collected again;
- a day pass: turns Pro on and takes nothing (refusing a wallet already short of a day); after a day it could not pay,
  it takes that day's payment, and Pro is on again.

`app_billing_wallet_subscriptions` keeps each subscription, keyed by subscription, with its `billing`. The plan's source
`wallet` gives Pro through monthly's last period paid (and its grace while a failed renewal is retried), or while a day
pass is on. The first owner turn of a UTC day that `Budget.admit` admits takes a day pass's payment in the background
(`billing/day-pass.ts`, through `Entitlements.payDay`), once a day; a tool's budget check (`Budget.open`) never does, so
an idle day costs nothing. A day the wallet is short lapses the pass from the next message; revoked or ended, it is
cancelled and runs to the end of the last day paid. The hourly cron (`billing/renewals.ts`) renews monthly only: it
reminds three days before a payment, collects it when due, retries a failed one each day through a seven-day grace and
then ends Pro; a subscription the owner revoked runs to what was paid. Monthly's notices reach the owner's Personal,
Activity and Telegram through the agent's internal `/internal/billing-notice` (`billing/notice.ts`), which needs no
plan; a day pass sends none. The card checkout and portal answer `card_disabled` unless `CARD_CHECKOUT` is `on`.

The browser reads billing state before mounting agent pages; unpaid accounts reach `/subscribe`. Any call refused with
`SubscriptionRequired` opens one upgrade prompt (`lib/upgrade-prompt.ts`) naming the feature when the error does,
with See Pro back to the page. The card return page polls verified state and Settings opens the Dodo portal while the
card checkout is on; a wallet subscription shows its paid-through date and Manage in your wallet. `/terms`, `/privacy` and `/refunds` are draft public pages,
pending operator identity and legal review. Native workerd tests verify signup, injected checkout, activation,
replay, stale updates, cancellation, grace and per-account allowances with real D1/Agent storage. They do not prove
live Dodo delivery or merchant onboarding.
