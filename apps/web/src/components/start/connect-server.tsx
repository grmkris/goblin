// A server Start just connected (ADR 0062). Connecting allows nothing: goblin can use none of its tools until the owner
// says so. The server's suggested access (ADR 0060) is one tap away here, as on its card in Connections.
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Button, Receipt } from '@goblin/ui'
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react'
import { messageOf } from '../../lib/query/app-error.ts'
import { allowSuggestedMutation, connectedToolsQuery, serversQuery } from '../../mcp/queries.ts'
import { suggestedApplied } from '../tool-grants.tsx'

/** Connection `connectionId`, once it is connected: Use suggested access until it is in place. Nothing otherwise. */
export function SuggestedAccess({ connectionId }: { readonly connectionId: string }) {
  const server = useQuery(serversQuery).data?.find((each) => each.connectionId === connectionId)
  const connected = server?.status === 'connected'
  const tools = useQuery(connectedToolsQuery(connectionId, connected)).data
  const allow = useMutation(allowSuggestedMutation)
  if (server === undefined || !connected) return null
  const applied = tools !== undefined && suggestedApplied(tools)
  return (
    <div className="start-connected">
      <p className="start-state" {...(applied ? { 'data-done': true } : {})}>
        <CircleCheckIcon aria-hidden />
        {applied
          ? `${server.label} is connected, with its suggested access.`
          : `${server.label} is connected. goblin can use none of its tools yet.`}
      </p>
      {!applied && (
        <Button pending={allow.isPending} disabled={tools === undefined} onClick={() => allow.mutate(connectionId)}>
          Use suggested access
        </Button>
      )}
      <p className="start-note">
        <span>
          Tools that say they only read run when needed; the rest ask you first. Change any of them on its card in{' '}
          <Link to="/connections">Connections</Link>.
        </span>
      </p>
      {allow.error !== null && (
        <Receipt tone="error">
          <CircleAlertIcon aria-hidden />
          <span>{messageOf(allow.error, 'use the suggested access')}</span>
        </Receipt>
      )}
    </div>
  )
}
