import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { clearNotifySink, notifySinkView, setNotifySink } from './notify.ts'
import { Sources } from './service.ts'

/**
 * The `sources` group (ADR 0066): each handler runs the Sources' program for the owner. Owner admission has already
 * admitted the request; a program's `AppError` is answered in its envelope.
 */
export const SourcesHandlers = HttpApiBuilder.group(OwnerApi, 'sources', (handlers) =>
  handlers
    .handle('list', () => Sources.use((sources) => sources.list))
    .handle('confirm', ({ params, payload }) => Sources.use((sources) => sources.confirm(params.id, payload.revision)))
    .handle('refuse', ({ params, payload }) => Sources.use((sources) => sources.refuse(params.id, payload.revision)))
    .handle('routes', ({ params }) => Sources.use((sources) => sources.routes(params.id)))
    .handle('route', ({ params, payload }) =>
      Sources.use((sources) => Effect.map(sources.route(params.id, payload, { actor: 'owner' }), ({ view }) => view)),
    )
    .handle('pause', ({ params }) => Sources.use((sources) => sources.pause(params.id)))
    .handle('resume', ({ params }) => Sources.use((sources) => sources.resume(params.id)))
    .handle('remove', ({ params }) => Sources.use((sources) => sources.remove(params.id))),
)

/** The `notify` group (ADR 0066): "Notify me via", read, set and cleared by the owner. */
export const NotifyHandlers = HttpApiBuilder.group(OwnerApi, 'notify', (handlers) =>
  handlers
    .handle('get', () => notifySinkView)
    .handle('set', ({ payload }) => setNotifySink(payload))
    .handle('clear', () => clearNotifySink),
)
