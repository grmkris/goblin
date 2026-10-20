# ADR 0088: Resident authority lasts until revoked

Status: Accepted. Amends ADR 0003 (resident authority was a 30-day window renewed by owner activity).

ADR 0003 gave the agent resident authority, its standing permission to use the owner's MCP connections while the
owner is away, as a 30-day window that each signed-in owner request renewed. An account used through a server's API
key (ADR 0081) is the owner's in name only: no one signs in, callers never renew it (ADR 0086), and after 30 days every
Persona answer and tool call failed until a person signed in again. The window was a dead man's switch, but the owner
already has an explicit one: turning authority off in Settings stops all outbound use at once, and it stays off.

## Decision

**Resident authority lasts until the owner revokes it.** The owner's first signed-in request grants it
(`GrantsResident`, formerly `RenewsResident`), and it stays active with no expiry. Revoking it in Settings ("Work
while you're away") is still sticky: activity never re-enables it, only the owner's toggle does. Callers and internal
calls still never grant it.

`ResidentStatus` is `never`, `active` or `revoked`, with `grantedAt` and `revokedAt`; `expired` and `expiresAt` are
gone. A forward migration renames `app_resident.renewed_at` to `granted_at` and drops `expires_at`, so an account whose
window had lapsed is active again.

## Consequences

- A key-only account keeps answering for as long as its owner leaves authority on.
- A leaked key, or an abandoned account, keeps acting until someone revokes the key or turns authority off; nothing
  stops it on its own. Keys still expire (90 days by default, ADR 0081).
- A Persona that cannot run says so (`unavailable`, ADR 0083), so a revoked account is visible to a server reading it.
