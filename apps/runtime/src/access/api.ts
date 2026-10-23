import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { Grants } from '../grants/service.ts'
import { requestCredential } from '../grants/policy.ts'
import { Forbidden } from '../http/errors.ts'

/**
 * The `access` group (ADR 0114): a credential's own grant, as `GET /api/access` and `/mcp`'s `access_read` answer it.
 * A member's session holds no grant (`Forbidden` `credential`).
 */
export const AccessHandlers = HttpApiBuilder.group(OwnerApi, 'access', (handlers) =>
  handlers.handle('read', () =>
    Effect.gen(function* () {
      const credential = yield* requestCredential
      if (credential === undefined) return yield* new Forbidden({ reason: 'credential' })
      return yield* Grants.use((grants) => grants.summary(credential))
    }),
  ),
)
