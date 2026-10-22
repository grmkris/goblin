# ADR 0104: Routine data stays as its producer sent it

Status: Accepted 2026-10-22 by the owner. Supersedes the scrub lines of ADR 0012 (event metadata "scrubbed, bounded to
1600 characters") and ADR 0041 (a notice's text redacted, its link only a plain http(s) address).

## Context

One function, `routineSummary`, scrubbed every piece of routine data: the event data sealed for a run (ADR 0012), a
run's report, and an event's notice (ADR 0041), which also redacted credential-named fields and cut its link down to
scheme, host and path. It replaced credential-shaped text (`Bearer …`, `token=…`, `sk-…`, private keys) and stripped
every link's credentials, query and fragment.

In the acceptance of mysi's workflows on 2026-10-22 it broke real data twice:

- The event data was the occurrence serialized to compact JSON and then scrubbed as text. The link pattern had no
  whitespace to stop at, so a link with a query swallowed every field after it: a `mysi.workflow_completed` payload
  lost its `sha256`, its `artifactId` and its closing braces. A link without a query turned the rest into
  `%22,%22sha256%22…`.
- The report a Persona posted lost the `?t=` of a MyMedia share link. That query is the link's access, so the link
  answered 404.

## Decision

Kris, 2026-10-22 02:50: "This is greenfield, so keep routine data open. No link or credential rewriting in routine
event data, run reports or notices for now; we tighten it only if a real leak shows up."

**Event data reaches the run as the producer's JSON.** A run handed an event reads its name, its time and its data, the
data untouched (`eventMetadata`, `routines/event-data.ts`). Data over 16 KiB is left out whole, with a note that gives
its size and says to read it with the server's tools; it is never cut. It is still sealed at rest under the run's
operation and revision, labelled as untrusted data in the run's prompt, and grants nothing.

**A run's report keeps its words.** Links and anything that looks like a credential stay as the model wrote them.
Terminal and bidi control characters are still stripped (they change how text shows, not what it says) and a report is
still bounded to 1600 characters (`routineSummary`).

**A notice keeps the producer's words and link.** Its title and body are the producer's, without controls and bounded
to 200 and 1200 characters. Its link is kept whole, credentials, query and fragment included, when it is an http(s)
address of at most 2048 characters; anything else is left out, never cut or shown as a link. A Source's notice of
someone else's message reads through the same text, so it keeps links too.

What is not routine data keeps its scrub: credential-named fields in remote tool results and in the arguments an
approval shows (`mcp/oauth/redaction.ts`), the transcript index (ADR 0035), and tool results' link blocks (ADR 0065).

## Consequences

- A link a producer sends works where it lands: the run's prompt, the report, the notice and the notice's copy
  through Notify me via.
- A secret a producer or the model puts in routine data reaches the run, the Topic, Activity and a notice's copy as
  written. The owner accepts that until a real leak shows up; tightening it again is a new ADR.
- A run whose event data is over 16 KiB fetches it through the server; nothing in its prompt is partial JSON.

## Rejected

- **A JSON-aware scrub** (redact credential-named keys, and stop the link pattern at a quote): it still strips the
  query that is a share link's access, which is what broke the report.
- **Cutting the JSON to a byte budget**: cut data is no longer the producer's JSON, and the run cannot tell what it
  lost.

Evidence: unit tests feed compact JSON with a link carrying a query and a `sha256` after it through `eventMetadata`
and get it back byte for byte, and leave data over the limit out with a note; the notice and report tests keep whole
links and credential-shaped words. The native signed Events case (local workerd) delivers the same shape through
signed ingress and finds it byte for byte in the sealed data and in the run's model input. A live producer on dev is
not yet accepted.
