import type { LeaseHolder } from '@goblin/contracts/internal'
import * as Effect from 'effect/Effect'
import type { RuntimeEnv } from '../../env.ts'
import { internalCall } from '../../inbound/client.ts'
import { reportAndRecover } from '../../observability/report.ts'

/**
 * Ends every published Events lease `holder` holds in workspace `workspaceId` (ADR 0112), before their access ends: one
 * `terminated` control goes to each. A failure is reported and the access still ends; a lease it missed lapses at its
 * end, a day at most.
 */
export const endLeases = (env: RuntimeEnv, workspaceId: string, holder: LeaseHolder) =>
  internalCall(env.AGENTS.getByName(workspaceId), (api) => api.publish.terminate({ payload: { holder } })).pipe(
    Effect.asVoid,
    reportAndRecover('publish.terminate', undefined),
  )

/** A key as the leases it holds name it. */
export const key = (keyId: string): LeaseHolder => ({ kind: 'key', keyId })

/** An installed app as the leases it holds name it: by its installation (ADR 0118). */
export const installed = (installationId: string): LeaseHolder => ({ kind: 'app', installationId })
