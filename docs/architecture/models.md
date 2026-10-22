# Models

## Models

Model calls go to one OpenAI-compatible endpoint ([ADR 0059](../adr/0059-bring-your-own-model-endpoint.md)): the
owner's own, set in Settings, else the deployment's when it has one. The deployment's is `GOBLIN_MODEL_BASE_URL` with
`GOBLIN_MODEL_KEY`, offering `GOBLIN_MODEL_ID` (the default) plus `GOBLIN_MODELS`; all three or none (`models.ts`
`deploymentEndpoint`, [ADR 0064](../adr/0064-openid-connect-and-config-driven-deployment.md)). The owner's is one row
in `app_model_endpoint` (`inference/store.ts`): its base URL, its key sealed by the credential cipher with the agent's id
as additional data, and the models it listed when it was set (`inference/endpoint.ts` checks the URL as an added
server's, then reads `GET <base>/models` with the key). `Inference` (`inference/service.ts`, built in
`layers/budget.ts`) resolves the endpoint in use and keeps it in memory until the owner changes it; the owner API
(`GET`, `PUT`, `DELETE /api/agent/model-endpoint`) answers its base URL, its models and the key's last four characters,
never the key.

Pi sees one provider, `goblin-litellm`, that serves every model id (`pi/model.ts`). Each request is resolved when it is
made: `Inference.served` gives the endpoint, its key and a model it serves (the id asked for when the endpoint lists
it, else its first), so turns, threads, subagents, Personas, routine runs, the memory model and an app's `llm` power
all follow the owner's endpoint, and a model id a conversation stored before a switch still answers. A call whose
endpoint cannot be read ends as a failed response.

**No endpoint at all.** A deployment without its own endpoint offers one placeholder model, `default`
(`ENDPOINT_DEFAULT`), which the owner's endpoint answers with its own default once they set one. Until then the
endpoint in use is `none`: `Inference.served` and `Budget.require` refuse with `NoModelEndpoint` (409, "This deployment
has no model endpoint. Bring your own model key in Settings."), so a send, a Source message, a routine firing
(recorded skipped), housekeeping and an app's `llm` power are refused before any call, and a call already under way
ends with those words (`inference/service.ts` `servedFailure`), which the chat shows as the notice to bring a key. The
model view's `source` is `none`, the picker offers nothing (`ModelChoice` without `current`), Start's model step and
Settings' card ask for the owner's endpoint, and no cap applies.

Each user picks the model their agent answers with, in the composer, among the models of the endpoint in use;
`models.ts` names and groups known ids by route (Google, Alibaba Cloud, Meta, Your subscription), because quota runs out per route, and offers
an unknown one under its own name, text only. The pick is one row in `app_model_choice`; without one, or when the
endpoint stops offering it, its default applies. Pi stores one model per conversation, set when it is created, so
before each turn the agent sets it (`PiSessions.setModel`) for the conversation the turn runs in, skipping it when that
conversation already has the model. A failed model call shows its reason in the chat, and a quota or outage failure
points at the picker.

Thinking is bounded by each model's own control, never by the output limit ([ADR
0083](../adr/0083-bounded-thinking-and-a-turn-that-answers.md)). `models.ts` records how each known model's thinking is
bounded and `pi/model.ts` (`thinkingFields`) sends it through pi-ai's `reasoning`, `compat` and `thinkingLevelMap`: a
`thinking_budget` per level for Qwen (Model Studio answers once it is spent), a `reasoning_effort` per level for
DeepSeek, GLM, Gemini and Muse. Asking at no level asks for the least: `enable_thinking: false` where the model can
switch thinking off (DeepSeek, Qwen), its least effort where it cannot (GLM, Gemini low; Muse minimal). A model goblin
does not know is sent no thinking control. Conversations think at medium (`pi/harness.ts`), and a Persona's fork at
its own level when it names one (`thinking`, low, medium or high, ADR 0100); housekeeping, which asks at
no level, thinks least. Each value was accepted by the deployment's endpoint (probed 2026-10-20).

Every response may run to 32 768 tokens (`MAX_OUTPUT_TOKENS`), a ceiling: on Model Studio DeepSeek and GLM share it
between thinking and answer. pi-ai sends the limit on every request, less whatever the context leaves short of the
window, so Pi compacts while the context still leaves a whole answer (`reserveTokens` in `pi/harness.ts`). pi-ai
estimates the context from the last answer's usage, its thinking included, so one long reasoning answer can leave the
next request a single token: below `MIN_ANSWER_ROOM` (4 096) goblin's stream sends nothing and fails as a context
overflow, which Pi compacts and retries once.

A response that ends (`length` or `stop`) with no text and no tool call is asked once more (`answering`): the request
goes again at no thinking level with a nudge to give the final answer or call a tool now, and that reply is the
response, its tokens counted with the first's and marked `goblin.recovered` in the run ledger. When it gives no answer
either, the response fails with `NO_ANSWER`, which Pi does not retry, marked cut off or empty; the chat says the
model gave no answer and points at the picker. Muse ends a thought cut off with an empty `stop`, which is why both stop
reasons count. An answer cut off mid-text ends with
`stopReason: 'length'`: the chat shows "Cut off at the output limit" under what it wrote, and Source replies carry the
same line.

Housekeeping (thread titles, main's summaries and skill-draft decisions) runs on `GOBLIN_MEMORY_MODEL`. Set it to a
cheap offered model; the code does not choose by price. Unset or not offered, it falls back to the default, and
without deployment models to the default of the owner's endpoint (`models.ts` `memoryModelId`, `memory/model.ts`). Its
tokens count toward the owner's daily usage like any other.

**The owner's own models** ([ADR 0087](../adr/0087-the-owners-own-subscription-models.md)). `GOBLIN_OWNER_MODELS` are
models on the deployment owner's own subscriptions, offered in `GOBLIN_OWNER_WORKSPACE_ID`'s workspace alone (ADR 0089), after every
account's (`offeredEndpoint`); another account never lists, picks or reaches one. A server's work never runs on them:
work through an API key, or in a Topic a key made (`serverWorkIn`, `keys/policy.ts`), answers on `Models.forServers`
(the pick, unless it is one of the owner's own, then the default), a Persona's own model there must not be one
(`Personas.ownModel`), a key reads the models without them (`Models.choiceForServers`) and cannot write one onto a
Persona. Nor do they serve other people: a workspace offered them takes no invitations (`offersOwnerModels`,
[ADR 0095](../adr/0095-the-owners-subscription-workspace-takes-no-members.md)).

## Daily token usage

Each agent counts its model tokens per UTC day ([ADR 0058](../adr/0058-no-plans-tokens-and-an-optional-cap.md)). A Pi
extension (`pi/budget.ts`) adds every model response's tokens, input, output and cached alike, to `app_usage_daily`.
The cheap model's calls (titles, memory, skill drafts, an app's `llm` power) and routine runs (`routines/usage.ts`,
from Pi's `pi.usage`) count the same way. Compaction summaries in main and threads are not counted yet.

Users of a deployment share its model key, so the deployment may cap each account's day with `GOBLIN_DAILY_TOKEN_CAP`
(the Worker's `DAILY_TOKEN_CAP`, a positive whole number); unset, while the owner uses their own endpoint, or without
a deployment endpoint, nothing is refused for tokens. Once a capped day is spent, new
turns are refused with `BudgetExhausted` until 00:00 UTC: HTTP 429 from the owner API, or a tool error from `/mcp`.
Source submissions, routine runs and housekeeping check the same cap. Tool calls inside a running turn are blocked,
so a looping turn ends after one more reply. Pi reports and swallows exceptions thrown by hooks, so the in-turn lever
is blocking tools, not throwing. Only a spent day blocks a tool as spent: a check that could not read the ledger blocks
the tool as a failed check and is reported. `GET /api/agent/usage` answers `{ used, limit, resetsAt }` in tokens, with
`limit` null without a cap. Settings shows today's tokens, and the composer shows a ring, re-read whenever a run ends:
the share of the cap used or, without a cap, how full the context was at the latest response, measured against the
model's `contextWindow`. Where the chat is wide enough the composer also shows the day's figure and the context's
tokens beside the ring. The model key's own cap stays the backstop.
