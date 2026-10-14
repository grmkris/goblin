// Start's steps (ADR 0062), one task each. Each says what the step is for in one line and offers the one action that
// does it; every step can be passed by. goblin uses the deployment's models until the owner brings their own (on a
// deployment without models of its own, ADR 0064, the model step says the owner's are needed), and a server
// connected from here gets no access until the owner gives it.
import { useMutation } from '@tanstack/react-query'
import type { OnboardingStep, ServerSuggestion } from '@goblin/contracts'
import { Button, GoblinMark, Skeleton, Textarea } from '@goblin/ui'
import { CpuIcon, PlugIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { QueryBoundary } from '../../lib/query/query-boundary.tsx'
import { startAddMutation } from '../../onboarding/queries.ts'
import { ModelEndpoint } from '../model-endpoint-card.tsx'
import { SuggestedServers } from '../server-add.tsx'
import { SuggestedAccess } from './connect-server.tsx'

/** Each step's name on the panel, its title, and the one line of why. */
export const STEP_TEXT: Readonly<Record<OnboardingStep, { label: string; title: string; why: string }>> = {
  welcome: {
    label: 'Welcome',
    title: 'goblin is your own agent',
    why: 'It thinks with the model you choose and works through the services you connect, using only the tools you allow.',
  },
  model: {
    label: 'Your model',
    title: 'The model goblin thinks with',
    why: "goblin uses this deployment's models, if it has any, unless you bring your own: any OpenAI-compatible endpoint and your key.",
  },
  services: {
    label: 'Services',
    title: 'How goblin reaches the outside world',
    why: 'Each service is an MCP server you connect. goblin can use none of its tools until you allow them.',
  },
  goblin: {
    label: 'Your goblin',
    title: 'What do you want goblin for?',
    why: 'Say it in your own words. goblin suggests a few Topics and Personas to start with.',
  },
}

/** What goblin is, in three pieces: goblin itself, the model it thinks with, and the services it reaches. */
export function WelcomeStep({ onContinue }: { readonly onContinue: () => void }) {
  return (
    <div className="start-action">
      <ul className="start-pieces">
        <li>
          <span className="start-piece-mark" aria-hidden>
            <GoblinMark />
          </span>
          <span className="start-piece-name">goblin</span>
          <span className="start-piece-about">Your agent, right here</span>
        </li>
        <li>
          <span className="start-piece-mark" aria-hidden>
            <CpuIcon />
          </span>
          <span className="start-piece-name">Your model</span>
          <span className="start-piece-about">This deployment's, or your own</span>
        </li>
        <li>
          <span className="start-piece-mark" aria-hidden>
            <PlugIcon />
          </span>
          <span className="start-piece-name">Your services</span>
          <span className="start-piece-about">MCP servers you connect and allow</span>
        </li>
      </ul>
      <Button size="cta" onClick={onContinue}>
        Get started
      </Button>
    </div>
  )
}

/** Where model calls go, as Settings shows it: this deployment's models, or the owner's own endpoint and key. */
export function ModelStep() {
  return (
    <div className="start-action start-model">
      <QueryBoundary action="read where your model calls go" pending={<Skeleton className="h-10 w-full" />}>
        <ModelEndpoint />
      </QueryBoundary>
      <p className="start-note">You can change it any time in Settings.</p>
    </div>
  )
}

/**
 * The servers we suggest. One that needs a sign-in comes back here (`connected`, the callback's connection); either way
 * the one just connected offers its suggested access.
 */
export function ServicesStep({ connected }: { readonly connected: string | undefined }) {
  const add = useMutation(startAddMutation).mutateAsync
  const [latest, setLatest] = useState(connected)
  const [message, setMessage] = useState('')
  const connectWith = async (item: ServerSuggestion): Promise<string> => {
    const started = await add(item.endpoint)
    if (started.authorizationUrl === undefined) setLatest(started.connectionId)
    else window.location.assign(started.authorizationUrl)
    return ''
  }
  return (
    <div className="start-action">
      {latest !== undefined && <SuggestedAccess connectionId={latest} />}
      <div className="start-more">
        <QueryBoundary action="show suggested services">
          <SuggestedServers connectWith={connectWith} onChanged={setMessage} onMessage={setMessage} />
        </QueryBoundary>
        {message !== '' && <p className="start-note">{message}</p>}
        <p className="start-note">Add any other MCP server by its address in Connections.</p>
      </div>
    </div>
  )
}

/** Ideas to start from: tapping one fills the field. */
const IDEAS = [
  'Plan a trip and keep every booking in one place',
  'Research a topic and write up what I should know',
  'Track my training and nudge me when I slack',
]

export function GoblinStep({
  pending,
  onStart,
}: {
  readonly pending: boolean
  readonly onStart: (text: string) => void
}) {
  const [text, setText] = useState('')
  const field = useId()
  return (
    <div className="start-action">
      <label className="sr-only" htmlFor={field}>
        What do you want goblin for?
      </label>
      <div className="start-kickoff">
        <Textarea
          id={field}
          rows={4}
          maxLength={2000}
          placeholder="I'm moving to Lisbon in March and…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <div className="start-ideas">
        {IDEAS.map((idea) => (
          <button key={idea} type="button" className="start-idea" onClick={() => setText(idea)}>
            {idea}
          </button>
        ))}
      </div>
      <Button size="cta" disabled={text.trim() === ''} pending={pending} onClick={() => onStart(text.trim())}>
        Start with this
      </Button>
    </div>
  )
}
