# 0058: No plans: access by sign-up, usage in tokens with an optional cap

Accepted 2026-10-14 with the owner. Supersedes ADR 0015 (plans and payments), ADR 0026 (the daily budget in Credits)
and ADR 0054 (Pro paid as a signed USDC subscription). Part of the cleanup that takes payments out of goblin (ADRs
0056, 0057).

## Context

goblin sold one plan, goblin Pro, first by card through Dodo (never configured), then as a USDC subscription signed in
the Goblin Wallet, as a day pass or monthly. Every turn, routine, hand-over, Event, held-call decision, Persona reply,
app power and skill checked the plan; the web gated its pages on it and offered an upgrade wherever a call was refused.
The daily allowance was counted in estimated Token Plan Credits, priced from one shared key's rates. The owner wants
goblin to be an open-source client anyone can deploy: whoever runs a deployment decides how, and whether, to charge,
outside goblin's code.

## Decision

- **goblin has no plans and takes no payments.** Pro, its catalog, the card checkout, the wallet subscription, the
  billing cron, the billing webhook and the account API's billing group are gone, and so is `SubscriptionRequired`. No
  program checks a plan.
- **Access is the sign-up mode.** `SIGNUP_MODE` (open, invite with its code, or closed) decides who gets an account;
  every account reaches its own agent and everything in it.
- **Usage is counted in tokens.** Each response's tokens (input, output and cached) count toward the account's UTC day.
  A deployment may set `DAILY_TOKEN_CAP`, a positive whole number; once a capped day is spent, every model call goblin
  makes (turns, routine runs, housekeeping, app powers, tools inside a turn) is refused with `BudgetExhausted` until
  00:00 UTC. Without a cap nothing is refused.
- **Charging is the deployment's business.** A hosted deployment that charges does so outside goblin: for example by
  issuing each customer their own model key with its own budget, or by choosing who may sign up.

## Consequences

- The auth D1 `app_billing_*` tables and `app_usage_daily.milli_credits` are left unread until the migrations are
  squashed.
- A per-account cap override is not built: a shared deployment has one cap for every account, and per-customer budgets
  belong to the keys a hosted deployment issues.
- The landing page, the terms and the privacy policy describe no prices or payments.
