# 0071: Sink delivery rules and exact event identity

Accepted 2026-10-15 as part of finalizing development. Amends ADR 0070's outcome, echo and revision rules;
its tool authority and file-link decisions remain in force.

## Context

An MCP call can complete successfully while its structured result says the external send was rejected, should be
retried later, or has an unknown outcome. Neither transport success nor an absent `isError` proves delivery.
A single connection can also multiplex unrelated services, so suppressing all of its notices loses legitimate copies.
Finally, saving the same sink twice in a second must invalidate the first revision.

## Decision

Notify me via keeps owner-reviewed `result` rules: `accepted`, optional `retryable`, and optional `rejected` each
compare a JSON pointer into `structuredContent` with a scalar. Optional `retryAt` names an epoch-millisecond time.
An MCP `isError` is rejected. Exactly one matching rule chooses the outcome; absent rules, unmatched values, and
conflicting matches are **unknown**. Goblin never infers these meanings from a server name, tool name or status word.
Unknown delivery is unconfirmed, terminal in the notice outbox, and never automatically retried. An app's `notify`
power reports it as an error instead of claiming delivery.

Retryable results retain the frozen bytes and operation id. The next attempt respects both local backoff and the
server's requested time; the existing five-attempt and fifteen-minute limits still apply. A receipt remains distinct
from delivery acceptance. Transport failures retain the existing bounded retry behavior and stable operation id;
exactly-once external effects are not promised.

An optional `echo` names the exact event and canonical arguments on the sink's connection. Notices retain their
originating selector so this rule is checked at creation and again at delivery. Another connection, event or selector
is not an echo. Copying a Source's answers into Settings also copies its wake selector for the owner to review; without
an echo selector there is no automatic suppression.

Every save assigns a fresh UUID through the platform Crypto service. The saved revision also binds the entire sink
configuration, including result and echo rules. A same-second identical save, or clear and recreation, invalidates an
in-flight or retrying copy.

## Consequences

Settings includes explicit delivery and echo rules. A tool without configured result semantics can still be called,
but its delivery remains unconfirmed. This is intentional; a generic host cannot invent the remote contract.
Application schema definitions add the sink policy/revision, the notice's event selector, and terminal `unknown` state.
They ship with the planned disposable development reset. No vendor table or production schema is changed here.

Unit tests exercise accepted/retryable/rejected/unknown results, conflicting rules, retry times, multiplexed selectors,
last-moment checks and same-second saves. Local workerd and browser checks cover the real runtime and Settings;
provider-side and deployed acceptance are separate.
