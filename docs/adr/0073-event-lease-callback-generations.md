# 0073: Event lease callback generations

Accepted 2026-10-16. Amends ADR 0041's one callback URL per connection: the authenticated hook path remains per
connection, while each subscription generation has a distinct callback query. Extends ADR 0011's lease recovery.

## Context

An Events producer addresses subscribe and unsubscribe by exact event selector and callback URL. An old unsubscribe
can arrive after a replacement subscribe, or an already-sent subscribe can arrive after retirement. Local revision
checks cannot recall requests already sent. Reusing the same callback URL lets those operations change the new lease;
waiting for every uncertain old lease to expire would block reconnect for up to a day.

## Decision

Each freshly prepared lease adds a random UUID as the `goblin_generation` query parameter of the connection's callback
URL. Reuse compares the base callback after removing only this parameter. Every other path and query component stays
intact. The marker is public identity, grants nothing, and contains no credential. The existing authenticated hook path,
per-lease signed payload, current resident authority and exact selector grant remain required.

Unsubscribe sends the retired lease's original full URL. A replacement has a different producer identity, so an old
subscribe or unsubscribe cannot replace or remove it. Failed cleanup remains uncertain and the old producer lease may
last until its finite expiry; this does not block reconnect. No external cancellation or exactly-once effect is claimed.

Consumer revisions remain monotonic. Prepared lease writes, subscription responses, poll receipts and verification
updates compare the durable generation before changing state. Retirement and replacement finish queued deliveries;
dispatch rechecks after asynchronous work so stale controls cannot revive or terminate a replacement. Termination
prevents asynchronous revival; an explicit subscribe prepares a fresh generation.

## Verification

Local native fixtures exercise signed challenges and official MCP transport over real SQLite, including older
consumer discovery, delayed unsubscribe, failed cleanup and reconstruction, delayed sealed polls, termination,
queued controls, and a subscribe whose dispatch guard already passed before retirement. Producer identity in the
fixture includes the full callback URL. Deployed producer and owner acceptance remain separate evidence.
