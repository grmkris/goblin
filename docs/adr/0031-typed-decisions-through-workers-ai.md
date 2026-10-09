# ADR 0031: Typed decisions through Workers AI

Accepted 2026-10-09 for the decisions branch, with the owner.

Goblin evaluates bounded candidates with Cloudflare Clef through the Workers AI `AI` binding. This is a scoped
exception to [ADR 0002](0002-stages-and-provider.md): conversational and housekeeping models still use Railway
LiteLLM in deployed stages. Clef is not a chat model choice and never generates a reply, a title or an instruction.

The critic applies deterministic state-only rules first, asks Clef only for undecided ordinary cases, then rechecks
the current registered chat, resident authority and relevant state before persisting a proposal. `none` and
`uncertain` remain valid ways to decline a suggestion. An unavailable binding, timeout, malformed answer, exhausted
budget or stale state produces no proposal and leaves the conversation working as before. A model call never holds
a SQLite transaction, Pi commit or lifecycle gate open.

Every call checks the owner's budget before dispatch and records returned usage as model `clef` into estimated
Credits ([ADR 0026](0026-daily-budget-in-credits.md)). Clef uses an explicit input-only app-budget estimate of 5,000 input tokens per Credit,
overridable through `MODEL_CREDIT_RATES`. Its published $0.24/M input-token price does not establish a USD-to-Token-Plan-Credit
exchange rate. Unknown usage is charged at the bounded full 65,536-token context reservation rather than treated as free. Aux telemetry uses purpose `decision` and model `cloudflare/clef`, with
content-free timings, outcome and token counters ([ADR 0024](0024-observing-conversations.md)). State, questions,
answers and proposal payloads never enter telemetry.

The first judgments propose attention highlights for Delegate reports, a draft thread for separate work, and earlier
work from the owner's other chats (cross-Topic context relevance). Reports remain visible and unread/completion state
stays a runtime fact. Report judgments are keyed by the relay's stable operation identity; resumed work cannot create
another proposal for it. Context candidates come only from the transcript index of ADR 0035 under its default Topic
policy (active Topics that take part in search, never the asking chat): the top three sources of a search for the
owner's newest message, each judged relevant or not at the frozen v4 threshold, with "none relevant" a valid outcome.
This ADR grants no new retrieval authority.

The signed-in owner confirms or dismisses each proposal. Application-owned `app_decision_proposals` and
`app_decision_labels` retain the outcome and its provider/probability label. Confirm may highlight an existing report,
open an empty thread draft, or use earlier work: for a day the chosen excerpts join the chat's requests as goblin's
quoted-history note (a `beforeRequest` context block, never a transcript entry), and each later owner message they
serve records an `auto` source use, so that answer's source strip names them. It never moves history. Repeated confirmation cannot repeat the action. A stale
proposal is discarded, and labels do not themselves enable automatic behavior. The v4 independent held-out report
does not establish readiness for any automatic judgment.

Decisions never grant authority, hide questions or approvals, declare external work complete, change a send's
destination, merge transcripts, or change any grant. All candidate prose is untrusted data. The authenticated owner
API derives the Agent from the session user; no endpoint accepts an Agent selector.

Delivery uses the owner-only workspace feed: proposals are part of a reconnect snapshot and committed change batches.
The browser renders them in its "Only visible to you" ephemeral slot; they are not appended to Pi transcripts or sent
to Telegram. Confirming a thread suggestion opens an empty thread draft in the browser that confirmed it. Local unit
and native workerd tests are separate from the conductor's dev deployment and owner acceptance.
