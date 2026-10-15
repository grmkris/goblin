# 0072: Source reply result outcomes and durable piece progress

Accepted 2026-10-15. Amends ADR 0066's reply delivery and retry behavior; extends ADR 0071's generic result rules to
Source replies. Source authority and exact-revision confirmation remain in force.

## Context

An MCP call can succeed while its structured result reports rejection, a retryable condition, or uncertainty.
Treating every successful envelope as sent hides those outcomes. Retrying an entire multi-piece answer can also replay
pieces the tool already accepted, and reconstructing the answer can change bytes or chunk boundaries.

## Decision

A reply may include owner-reviewed `result` rules, using the same `SinkResultRules` as Notify me via: required
`accepted`, optional `retryable` and `rejected` comparisons of JSON pointers into `structuredContent` with scalar
values, plus an optional `retryAt` pointer to epoch milliseconds. Exactly one match classifies a result. No rules,
no match, or conflicting matches mean unknown. MCP `isError` means rejected. No server or tool name implies a rule.

Accepted advances the durable piece cursor. Retryable retains the same piece and frozen arguments, honoring local
backoff and the producer's requested time. Rejected and unknown are terminal and visible to the owner. A terminal row remains due until its ledger/report and
owner notice succeed; retries only repeat reporting with the same ids, never the external call. Transport
uncertainty is unknown and never automatically retried. Tool acceptance does not prove external delivery.

Before dispatching any piece, persist the complete call plan: reply text cut into pieces, filled arguments, stable
operation ids, connection, tool, reviewed setup and result rules. Persist each accepted acknowledgement before the
next dispatch. Recovery uses the plan without rereading the Pi answer. Persist dispatch intent before each tool call;
an intent retained without a result on recovery is unknown, because the external effect may already have happened.
An entirely acknowledged plan settles accepted even after settings change, since it needs no further dispatch.

The Source wake is single-flight. Every actual call rechecks the original Source revision, binding, active state and
setup after connection/credential waits, in addition to current resident authority and exact tool grants. No SQLite
transaction or admission lock spans a network call. Retry attempts are bounded to five and all waiting to one day
from the original message. A later `retryAt` expires at the deadline without an early retry; inactive waiting obeys that limit. Retiring a binding, including owner Pause,
rejects pending calls that belong to it.

The owner can edit reply result rules in a Source review. Saving requires the current revision, retires the old
binding and creates a new proposed revision. Only explicit confirmation activates it. Binding attempts reserve a
unique durable `lastBinding` value, then compare-and-set activation against the reviewed revision, setup, state and
reservation after network waits. Confirm/resume, cleanup and resubscription cannot overwrite a newer edit or binding. Copying that Source into
Notify me via copies its result rules as well as its reply template and wake selector.

## Consequences

The application-owned reply table adds frozen plan, source revision/binding, dispatch intent and piece progress, with
accepted/rejected/unknown/given_up terminal outcomes. The fresh baseline changes with the planned disposable dev
reset. Vendor tables and production are untouched by this implementation.

Unit tests cover structured outcomes, uncertain transport, resumed chunks, deadlines and reconstruction. Native
workerd checks exercise the raw MCP result path, and browser checks exercise owner review and copying at desktop and
phone widths. Live MySI and Mygram acceptance is a separate scheduled check.
