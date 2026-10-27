# ADR 0105: A key's secret rotates in place

Status: Accepted 2026-10-22. Amends ADR 0081 (a key's secret is replaced without replacing the key).

A server API key's secret leaks the way any secret does: printed into a log or an agent's session, pasted into the
wrong window. Everything about a key is recorded against its id: its reach (`app_key_reach` in the agent, the Topics,
chats and Personas it made, ADR 0081), its scopes (ADR 0084) and its servers and origins (ADR 0091). Better Auth's
update never changes a key's secret, so the only remedy was a new key, which reaches none of what the old one made: a
server with a Topic and Personas per customer lost all of them.

## Decision

**Rotate.** `POST /api/keys/:keyId/rotate`, on the workspace account API (`/w/<slug>/api/keys/:keyId/rotate`), for the
workspace's owners and admins, who make, change and revoke its keys; a member is refused (`forbidden`, `role`), and a
key never reaches the account API. It answers as `create` does, the key and its secret, shown this once. A key of
another workspace's, or one revoked or expired, is `not_found`.

**The same key.** The key keeps its id, name, scopes, servers, origins, maker and expiry, and so its reach. Only its
secret changes: a new one made as the plugin makes one for a new key (`gbk_` and 64 letters from Better Auth's
generator), stored as the plugin stores one (the hash of `defaultKeyHasher` in `key`, its first 10 characters in
`start`), written with `updatedAt` through Better Auth's own adapter on the plugin's table (`rotateKey`,
`auth/api-keys.ts`).

**The old secret stops at once.** The row holds one hash, so from the moment the rotation is written the old secret
matches no key: its next request is `unauthenticated` (`key`). A request already admitted finishes as it began.

**Audit.** A rotation is one `api_key` line (`kind: secret`) with the key, the workspace, who rotated it and the
request's reference; never a secret, the old one or the new (ADR 0024).

**Settings.** API keys → Rotate secret on each key, behind a confirmation that the old secret stops working at once and
anything using it needs the new one; then the new secret, shown once, as a new key's is.

## Consequences

- A leaked secret ends without what its key made: the server takes the new secret and carries on in the same Topics,
  threads and Personas, with the same scopes.
- There is no overlap. A server still holding the old secret is refused until it has the new one, so rotating a key in
  use costs that server the time it takes to swap the secret in.
- An expired key is not brought back by a rotation; a new lifetime is a new key.
- The plugin keeps its key generator to itself, so `rotateKey` repeats it; `KEY_LENGTH` and `KEY_START_LENGTH` set both
  the plugin's options and the rotation, and the tests hold a rotated secret to a made one's shape.

## Rejected

- **A new key, and re-binding the old key's reach to it**: the reach is the agent's rows and the scopes, servers and
  origins the auth store's, all under the key's id. Moving them is a migration across two stores for every key, with a
  window in which neither key has them; one id leaves nothing to move.
- **A grace period in which both secrets work**: Better Auth's table holds one hash per key. A second would need a
  column of ours on its table, or a table beside it that verification reads, a custom adapter in all but name. And a
  leaked secret is why a key rotates: keeping it working is what the owner wants to stop.
- **Better Auth's own update**: it changes a key's name, permissions, metadata, expiry and limits, never its secret.
