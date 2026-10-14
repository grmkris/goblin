import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { ServerAppPage } from '../components/server-app.tsx'
import { parseFocus } from '../lib/app-focus.ts'
import { primeOwnerRead } from '../lib/prime.ts'
import { serversQuery } from '../mcp/queries.ts'

/**
 * A server's own App (ADR 0053), opened from the sidebar, its card or Start, on one of its panels when the link names
 * it (`?focus=<panel>`): its thread and App are kept, then its page shows.
 */
export const Route = createFileRoute('/connections_/$connectionId/app')({
  validateSearch: parseFocus,
  loader: async ({ context }) => {
    await primeOwnerRead(context.queryClient, serversQuery)
  },
  component: ServerAppRoute,
})

function ServerAppRoute() {
  const { connectionId } = Route.useParams()
  const { focus } = Route.useSearch()
  return (
    <OwnerGate>
      <ServerAppPage connectionId={connectionId} {...(focus === undefined ? {} : { focus })} />
    </OwnerGate>
  )
}
