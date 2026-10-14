# 0057: goblin pays for no model call

Accepted 2026-10-14 with the owner. Supersedes ADR 0047 (inference paid per call from the owner's wallet), part of the
cleanup that takes crypto out of goblin (ADR 0056).

## Context

ADR 0047 let a model call pay its own way: a pay mode (Credits, then the Goblin Wallet), two paid routes (goblin's own
`/v1/chat/completions` behind an MPP charge, and Tempo's MPP proxy), a hidden `inference` MCP caller that paid each
402 challenge through the wallet's `pay_challenge`, and telemetry that read the refusal code out of the error's words.
It put a wallet, `mppx` and `viem` into goblin's model client, its admission and its run ledger. The owner wants goblin
to be a generic MCP client that never pays for anything itself: the model is whatever endpoint the deployment, and
later the owner, brings.

## Decision

- A model call goes to the deployment's model endpoint, and nowhere else. There is no pay mode, no paid route, no
  `inference` caller and no endpoint of goblin's that sells inference.
- A failed model call is the provider's failure (`provider_error`) in the run ledger, never classified by its words.
- Paying per call in crypto, where wanted, belongs to whoever serves the model: a wallet or gateway that exposes an
  OpenAI-compatible endpoint is just another model endpoint.

## Consequences

- `app_pay_mode` is left unread until the migrations are squashed; its migration stays until then.
- Credits are still counted for every call until the plan gate and Credits are replaced by token usage.
