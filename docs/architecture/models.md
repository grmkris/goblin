# Models

## Models

Typed decisions are the scoped Workers AI exception ([ADR 0031](../adr/0031-typed-decisions-through-workers-ai.md)): Clef
judges bounded state and questions through `AI` after the rules decide what they can. It is never a chat model, and
its calls check the daily cap and count their tokens like the cheap model's.

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

Housekeeping (thread titles, main's summaries and skill-draft decisions) runs on `GOBLIN_MEMORY_MODEL`. Set it to a
cheap offered model; the code does not choose by price. Unset or not offered, it falls back to the default
(`models.ts`, `memory/model.ts`). Its tokens count toward the owner's daily usage like any other.

## Daily token usage

Each agent counts its model tokens per UTC day ([ADR 0058](../adr/0058-no-plans-tokens-and-an-optional-cap.md)). A Pi
extension (`pi/budget.ts`) adds every model response's tokens, input, output and cached alike, to `app_usage_daily`.
The cheap model's calls (titles, memory, skill drafts, an app's `llm` power), Clef's decisions (a Clef call whose usage
is unknown counts its whole 65,536-token context) and routine runs (`routines/usage.ts`, from Pi's `pi.usage`) count
the same way. Compaction summaries in main and threads are not counted yet.

Users of a deployment share its model key, so the deployment may cap each account's day with `GOBLIN_DAILY_TOKEN_CAP`
(the Worker's `DAILY_TOKEN_CAP`, a positive whole number); unset, nothing is refused. Once a capped day is spent, new
turns are refused with `BudgetExhausted` until 00:00 UTC: HTTP 429 from the owner API, or a tool error from `/mcp`.
Telegram submissions, routine runs and housekeeping check the same cap. Tool calls inside a running turn are blocked,
so a looping turn ends after one more reply. Pi reports and swallows exceptions thrown by hooks, so the in-turn lever
is blocking tools, not throwing. Only a spent day blocks a tool as spent: a check that could not read the ledger blocks
the tool as a failed check and is reported. `GET /api/agent/usage` answers `{ used, limit, resetsAt }` in tokens, with
`limit` null without a cap. Settings shows today's tokens, and the composer shows a ring, re-read whenever a run ends:
the share of the cap used or, without a cap, how full the context was at the latest response, measured against the
model's `contextWindow`. Where the chat is wide enough the composer also shows the day's figure and the context's
tokens beside the ring. The model key's own cap stays the backstop.
