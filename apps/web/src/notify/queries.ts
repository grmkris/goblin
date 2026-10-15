import { mutationOptions } from '@tanstack/react-query'
import type { NotifySink } from '@goblin/contracts'
import { owner } from '../lib/api.ts'

/**
 * "Notify me via" on the owner API (ADR 0066): the one tool of one connection goblin sends the owner's notices with.
 * Keys are `['notify', kind]`.
 */
const notifyKeys = { sink: ['notify', 'sink'] as const }

/** Where notices go to the owner: a connection's tool and its arguments, or null while none is set. */
export const notifySinkQuery = owner.apiQuery({ queryKey: notifyKeys.sink, queryFn: (api) => api.notify.get() })

/** Sets where notices go, or clears it with null; the answer is the setting as it is now. */
export const setNotifySinkMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, sink: NotifySink | null) =>
      sink === null ? api.notify.clear() : api.notify.set({ payload: sink }),
  }),
  onSuccess: (view, _sink, _result, { client }) => client.setQueryData(notifyKeys.sink, view),
})
