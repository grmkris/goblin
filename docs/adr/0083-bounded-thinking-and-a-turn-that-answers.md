# ADR 0083: Bounded thinking, and a turn that answers

Status: Accepted.

goblin marked every model `reasoning: false`, so pi-ai sent no thinking control and the harness's thinking level never
reached a provider: each model thought at its own default, bounded only by the output limit (32,768 tokens). On Model
Studio DeepSeek V4 and GLM 5.3 share that limit between thinking and answer. A Persona's DeepSeek V4.1 Flash turn spent
all of it thinking, wrote no text, and pi-durable took the empty `length` response as the answer: the Persona "gave no
answer" and a server reading the chat saw only `failed`. Muse Spark 1.3 at its default effort does the same, and ends a
cut-off thought with an empty `stop`.

Every provider documents the output limit as a hard cutoff that can leave no answer, and says to bound thinking with
its own control instead (OpenAI and Anthropic effort, Google `thinking_level`, Qwen `thinking_budget`). Agents that hit
this treat a response with no text and no tool call as a failure and ask again with a nudge (Gemini CLI, OpenHands;
pi-ai's thinking budget field came from the same failure, earendil-works/pi#7640). Raising the limit does not help: a
runaway thought spends whatever it is given.

## Decision

**Thinking is bounded by each model's own control.** `models.ts` records how each known model's thinking is bounded,
and `pi/model.ts` sends it through pi-ai's `reasoning`, `compat` and `thinkingLevelMap`:

| Model | At a level | At no level |
| --- | --- | --- |
| Qwen 3.8 Max, Flash | `thinking_budget` (8,192 at medium; Model Studio answers once it is spent) | thinking off |
| DeepSeek V4 Pro, V4.1 Flash | `reasoning_effort` low, high or max (medium is high) | thinking off |
| GLM 5.3 | `reasoning_effort` low, high or max | low (it cannot be switched off) |
| Gemini 3.8 Flash | `reasoning_effort` low, medium or high | low |
| Muse Spark 1.3 | `reasoning_effort` minimal to max | minimal |

Every value was accepted by the deployment's endpoint (probed 2026-10-20). A model goblin does not know is sent no
thinking control. Conversations think at **medium**; housekeeping, which asks at no level, thinks least. The output
limit stays a ceiling.

**A response without an answer is asked once more.** goblin's model streams (`answering`) catch a response that ended
(`length` or `stop`) with no text and no tool call, and send the request again at no level, which asks for the least
thinking the model allows, with a nudge to give the final answer or call a tool now. That reply is the response, its
tokens counted with the first's and marked `goblin.recovered` in the run ledger. When it gives no answer either, the
response fails with goblin's own words (`NO_ANSWER`), which Pi does not take for a passing provider failure, marked
cut off or empty. Pi still sees one response per request; the live partials of both reach the chat as they come.

**A failed Persona invocation says why.** An invocation settles as one typed outcome: answered with its entry, failed
with its reason, or stopped. The reason (`no_answer`, `model_error`, `budget`, `unavailable`) is on every invocation
view, the forward read of ADR 0081 included.

**Muse Spark 1.3 is a known model**, on its own route (Meta), text only: it drops images on this route.

## Consequences

- The retried request answers without deliberation. On a hard step that answer is worse than a good thinking answer
  (Qwen3's report: AIME'25 81.5 thinking, 24.7 not), but it is an answer, and the next step thinks again.
- DeepSeek on Model Studio takes no thinking budget, only an effort, and GLM ignores budgets: their thinking stays
  bounded by effort, and by recovery when it runs over.
- The invocation reason arrives in an additive migration so production keeps its agents, like ADR 0081's; it folds into
  the baseline at the next reset the owner decides on.
- Meta answers Muse with a spurious 404 `model_not_found` in spells, independent of thinking. Pi does not retry a 404,
  so those turns fail as model errors; retrying them belongs to the model gateway.
