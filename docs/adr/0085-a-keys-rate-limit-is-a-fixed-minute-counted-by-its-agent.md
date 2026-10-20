# ADR 0085: A key's rate limit is a fixed minute, counted by its agent

Status: Accepted. Amends ADR 0081 (where a key's rate limit is kept and how it is answered).

ADR 0081 limited each key to 600 requests a minute with Better Auth's per-key limiter. That limiter resets its count
only when the time since the key's last accepted request passes the window, and every accepted request moves that time
to now. A client that never pauses for a minute is therefore counted from its first request on: Swarmm's server, polling
at about 100 requests a minute, reached 600 after six minutes and was refused for a minute, again and again, while
always well below the limit it was promised. The refusal was a 401 `key_rate_limited` on `/api` and a bare
`{"error":"Unauthenticated"}` on `/mcp`, which said neither why nor for how long.

## Decision

- **The plugin's limiter is off** (`rateLimit: { enabled: false }`). Its global switch is read before a key's own stored
  window, so keys made before are freed too, with no change to their rows.
- **The agent counts a key's requests per fixed minute of the clock**: owner admission (`http/api/middleware.ts`, over
  `keys/rate.ts`) takes one for each request a key sends that its scope admits, 600 a minute, and past them refuses with
  `Unauthenticated` `key_rate_limited` and `retryAfter`, the whole seconds until the next minute. Every request a key
  sends, over `/api` or as an `/mcp` tool, reaches its user's agent, so one count covers both. The count lives in the
  agent's memory: a restart forgets it, which only ever lets a key through sooner.
- **A refusal says when to come back.** The edge adds `Retry-After` to a key's refusal that carries `retryAfter`; an
  `/mcp` tool answers it as its error result with the same fields; and a key that does not admit on `/mcp` gets the same
  envelope as on `/api` (`unauthenticated`, its reason and the request's `ref`).

## Consequences

- A steady client below 600 a minute is never refused; a burst of more than 600 within one clock minute is, until the
  minute ends.
- The limit is the agent's, not the auth store's, so verifying a key no longer counts anything; a flood of requests with
  a key still costs a verification each before the agent refuses it.
- The status stays 401 with reason `key_rate_limited`, as ADR 0081 named it; clients read `retryAfter` or `Retry-After`.
