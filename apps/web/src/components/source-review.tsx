// A Source's card (ADR 0066): its five facts in words, the exact setup folded under them, and the owner's Confirm or
// Refuse of that exact revision, then Pause, Resume and Remove. Confirming is an authenticated owner operation on the
// revision shown, never something a tool's text or a server's suggestion does.
import { useMutation, useQuery } from '@tanstack/react-query'
import type { SourceView } from '@goblin/contracts'
import { Conflict, InvalidInput } from '@goblin/contracts/api'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  JsonView,
} from '@goblin/ui'
import { ChevronRightIcon } from 'lucide-react'
import { eventTitle, eventWords } from '../lib/events.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'
import { newKeysWords, sourceStatus } from '../lib/source-routes.ts'
import { setupFacts } from '../lib/source-setup.ts'
import { usePersonas, useTopics } from '../lib/workspace/hooks.ts'
import { eventsQuery, serversQuery } from '../mcp/queries.ts'
import { type SourceChange, changeSourceMutation } from '../sources/queries.ts'
import { StatusLabel } from './status-label.tsx'

/** Why a change to a Source was refused, in words the owner can act on; else the calm generic line. */
export function sourceRefusal(failure: unknown, action: string): string {
  if (failure instanceof Conflict)
    return withRef('This Source changed since you read it. Review its current revision below.', failure)
  return messageOf(failure, action)
}

/**
 * What a Source's event is called: the server's title for it while its connection is connected and lists it, else its
 * name in words. Only a connected connection is asked, as a routine's review does.
 */
function useEventTitle(source: SourceView): string {
  const servers = useQuery(serversQuery).data
  const connected = servers?.some(
    (server) => server.connectionId === source.connectionId && server.status === 'connected',
  )
  const streams = useQuery(eventsQuery(connected === true ? source.connectionId : undefined)).data
  const stream = streams?.find((each) => each.name === source.setup.wake.event)
  return stream === undefined ? eventWords(source.setup.wake.event) : eventTitle(stream)
}

/** The setup exactly as goblin keeps it, folded: every pointer, tool and argument template. */
function ExactSetup({ source }: { readonly source: SourceView }) {
  return (
    <Collapsible>
      <CollapsibleTrigger render={<button type="button" className="event-advanced-toggle" />}>
        <ChevronRightIcon aria-hidden />
        Exact setup, revision {source.revision}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <JsonView value={source.setup} initialDepth={2} />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The changes a Source in its state offers, each with its label and look. */
function changesOf(source: SourceView): readonly {
  readonly change: SourceChange
  readonly label: string
  readonly variant: 'default' | 'outline' | 'ghost'
}[] {
  const { id, revision } = source
  switch (source.state) {
    case 'proposed':
      return [
        { change: { action: 'confirm', id, revision }, label: 'Confirm', variant: 'default' },
        { change: { action: 'refuse', id, revision }, label: 'Refuse', variant: 'ghost' },
      ]
    case 'active':
      return [
        { change: { action: 'pause', id }, label: 'Pause', variant: 'outline' },
        { change: { action: 'remove', id }, label: 'Remove', variant: 'ghost' },
      ]
    case 'paused':
      return [
        {
          change: { action: 'resume', id },
          label: source.paused === 'review' ? 'Review done, resume' : 'Resume',
          variant: 'default',
        },
        { change: { action: 'remove', id }, label: 'Remove', variant: 'ghost' },
      ]
    case 'refused':
      return [{ change: { action: 'remove', id }, label: 'Remove', variant: 'ghost' }]
  }
}

/** What confirming does, said before the owner does it. */
const CONFIRM_NOTE =
  'Nothing runs until you confirm this exact setup. Confirming lets goblin take this event and call these tools for you. Messages where you speak become your own turns; their words stay data and grant nothing, and tools that ask first still ask.'

/** A Source's card: its facts, its exact setup, and what the owner may do with it in its state. */
export function SourceReview({ source }: { readonly source: SourceView }) {
  const changing = useMutation(changeSourceMutation)
  const topics = useTopics()
  const personas = usePersonas()
  const event = useEventTitle(source)
  const facts = setupFacts(source.setup, { event, newKeys: (newKeys) => newKeysWords(newKeys, topics, personas) })
  const pending = changing.isPending ? changing.variables.action : undefined
  const error = changing.error === null ? '' : sourceRefusal(changing.error, 'change this Source')
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="routine-title">{source.title}</span>
        </CardTitle>
        <CardDescription>
          <span className="routine-title">
            A Source on {source.label}, {source.proposedBy === 'agent' ? 'proposed by goblin' : 'proposed by you'}
          </span>
        </CardDescription>
        <CardAction>
          <StatusLabel label={sourceStatus(source)} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          <dl className="routine-facts">
            {facts.map((fact) => (
              <div key={fact.term}>
                <dt>{fact.term}</dt>
                <dd>{fact.text}</dd>
              </div>
            ))}
          </dl>
          {source.health !== undefined && <p className="server-note">{source.health}</p>}
          {source.state === 'proposed' && <p className="server-note">{CONFIRM_NOTE}</p>}
          <ExactSetup source={source} />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="card-actions">
            {changesOf(source).map(({ change, label, variant }) => (
              <Button
                key={change.action}
                size="sm"
                variant={variant}
                pending={pending === change.action}
                disabled={pending !== undefined}
                onClick={() => changing.mutate(change)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
