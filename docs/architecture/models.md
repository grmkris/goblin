# Models

## Models

Typed decisions are the scoped Workers AI exception ([ADR 0031](../adr/0031-typed-decisions-through-workers-ai.md)): Clef
judges bounded state and questions through `AI` after the rules decide what they can. It is never a chat model, and
its calls check and charge the budget like the cheap model's (input only, 5,000 tokens per Credit by default).

Each user picks the model their agent answers with, in the composer. The deployment offers `GOBLIN_MODEL_ID` (the
default) plus `GOBLIN_MODELS`, all served by the same LiteLLM key; `models.ts` names and groups them by route
(Google, Alibaba Cloud), because quota runs out per route. The pick is one row in `app_model_choice`; without one, or
when the deployment stops offering it, the default applies. Pi stores one model per conversation, set when it is
created, so before each turn the agent sets it (`PiSessions.setModel`) for the conversation the turn runs in,
skipping it when that conversation already has the model. Every offered model is registered with
Pi's `Models` under the one `goblin-litellm` provider. A failed model call shows its reason in the chat, and a
quota or outage failure points at the picker.

Every response may run to 32 768 tokens (`MAX_OUTPUT_TOKENS`, `pi/model.ts`): reasoning models spend part of it
thinking. pi-ai sends the limit on every request, less whatever the context leaves short of the window, so Pi
compacts while the context still leaves a whole answer (`reserveTokens` in `pi/harness.ts`). pi-ai estimates the
context from the last answer's usage, its thinking included, so one long reasoning answer can leave the next request a
single token: below `MIN_ANSWER_ROOM` (4 096) goblin's stream sends nothing and fails as a context overflow, which Pi
compacts and retries once. An answer that reaches the limit ends with `stopReason: 'length'`: the chat shows "Cut off
at the output limit" under what it wrote (or, when it wrote nothing but thinking, says so and points at the picker),
and Telegram adds the same line. glm-5.3 on the Token Plan thinks until the limit on hard prompts and ignores a thinking
budget (probed 2026-10-12), which is why the picker says so.

A stage that sets `GOBLIN_PAID_INFERENCE` sells model calls paid per call from the owner's Goblin Wallet (ADR 0047), on
two routes: `goblin` (this stage's own paid endpoint, the same model) and `tempo` (Tempo's MPP proxy, its DeepSeek), each
its own Pi provider (`goblin-paid-*`, `pi/model.ts`). The model pick stays a model; when a call is paid is the owner's
pay mode (`pay-mode.ts`, one row in `app_pay_mode`, `GET`/`PUT /api/agent/pay`): `credits-then-wallet` (the default),
`credits` or `wallet`, with a route (`goblin` by default). Pi's conversations mark their calls through the harness's
stream metadata (`CONVERSATION_CALL`), and `goblin-litellm`'s stream asks `payingRoute` before each marked call: every
call in `wallet` mode, and in `credits-then-wallet` once the day's Credits are spent while the wallet can pay, goes to
the paid route's provider with the same model id, never with goblin's LiteLLM key. Asked per call, a turn whose Credits
run out midway goes on paid. Unmarked calls (housekeeping) and routines' own providers stay on Credits. The wallet can
pay when it is connected and its payment tool (`pay_challenge`) is allowed to run without asking. Admission follows the
mode: `Budget.admit` (an owner's turn, a Persona's, the tool hook) lets a turn through past the Credits in `wallet` mode,
or in `credits-then-wallet` while the wallet can pay; `Budget.require` (routines, housekeeping) keeps to the Credits. A
paid call goes out with no key of goblin's. A 402's MPP challenge is paid by the wallet's payment tool through the MCP
caller `inference` (`mcp/inference-pay.ts`), which only that tool admits and the model never sees, and the request is
sent once more with the credential. The wallet holds the payment as unknown until goblin reports the answer's
`Payment-Receipt` under the same operation (`inference:<challenge id>`), which it does while the answer streams. A
refusal, or a spend the wallet holds for approval over a limit, comes back as the provider's 402 in the wallet's words
with its refusal code (`Payment from your Goblin Wallet failed (<code>): …`, `pi/model.ts` `paymentFailed`); the run
ledger keeps only `payment_refused:<code>` (`telemetry/safety.ts`), and the chat marks an empty wallet
(`walletFunds`, `lib/chat-messages.ts`). A second 402 after a payment ends the call as `refused_after_payment`, and
paid streams make no client retries. A paid answer names its paid provider, so it is not recorded in Credits.
goblin's own paid endpoint, `POST /v1/chat/completions` (`http/paid-inference.ts`), sells the stage's models behind an
`mppx` `tempo` charge in USDC.e to `GOBLIN_MPP_RECIPIENT`, priced up front as Tempo's proxy prices (0.6 of a unit per
output token it may write, 0.1 per input token, at least $0.00075). It forwards a paid call to LiteLLM with the stage's
key and returns the payment's receipt. The Worker imports it on the route's first call, keeping `mppx` and `viem` out
of every isolate's startup, which has a CPU limit. Settings' "How goblin pays for its model" card (`inference-card.tsx`) chooses the
pay mode and, where the stage sells both, the route; the composer says "Paying per call" while calls are paid, and
Activity's Get started offers the wallet while a mode would use it and it cannot pay yet.
Paying per call needs a plan like everything else: without Pro a turn is refused before the pay mode is read.

Housekeeping (thread titles, main's summaries and skill-draft decisions) runs on `GOBLIN_MEMORY_MODEL`. Set it to a
cheap offered model; the code does not choose by price. Unset or not offered, it falls back to the default
(`models.ts`, `memory/model.ts`). Its tokens count toward the owner's daily budget like any other.

## Model budget

Users share the deployment's model key, so each agent has a daily budget in estimated Alibaba Token Plan Credits,
the unit the plan bills (ADR 0026), per UTC day: Pro's 800, or the account's operator override (`daily_credits`). A
Pi extension (`pi/budget.ts`) records every model response's tokens in `app_usage_daily` and prices them in
thousandths of a Credit at its model's rate (`budget-credits.ts`): by default about 5 000 fresh input, 50 000 cached
input or 830 output tokens per Credit, Alibaba's own example, with per-model overrides and aliases in
`GOBLIN_MODEL_CREDIT_RATES` (Gemini 3.8 Flash is priced as Qwen 3.8 Flash; Clef, `clef`, has an input-only rate
of its own, and a Clef call whose usage is unknown is charged its whole 65,536-token context). The cheap model's calls
(titles, memory, skill drafts, an app's `llm` power), Clef's decisions and routine runs (`routines/usage.ts`, from
Pi's `pi.usage`) count the same way.
Compaction summaries in main and threads are not counted yet. Once the day is spent, new turns are refused with `BudgetExhausted`: HTTP 429 from the owner API,
or a tool error from `/mcp`. Telegram submissions check the same budget. Tool calls inside a running turn are blocked,
so a looping turn ends after one more reply. Pi reports and swallows exceptions thrown by hooks, so the in-turn lever
is blocking tools, not throwing. Only a spent budget blocks a tool as spent: an account without a plan is told to
subscribe, and a check that could not read the plan or the ledger blocks the tool as a failed check and is reported
(ADR 0026, amended). The allowance is the plan's, read through the agent's `Entitlements`.
Settings shows today's usage, and the composer shows it as a ring, re-read whenever
a run ends. On wider screens the composer also
shows how full the context was at the latest response, measured against the model's `contextWindow`. The model key's
own cap stays the backstop.
