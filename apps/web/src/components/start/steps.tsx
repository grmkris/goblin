// Start's steps (ADR 0062), one task each. Each says what the step is for in one line and offers the one action that
// does it; every step can be passed by. goblin uses the deployment's models until the owner brings their own (on a
// deployment without models of its own, ADR 0064, the model step says the owner's are needed), and a server
// connected from here gets no access until the owner gives it.
import { useMutation } from '@tanstack/react-query'
import type { OnboardingStep, ServerGroup, ServerSuggestion } from '@goblin/contracts'
import { Button, Input, Skeleton, Textarea } from '@goblin/ui'
import { useId, useState } from 'react'
import { QueryBoundary } from '../../lib/query/query-boundary.tsx'
import { startAddMutation } from '../../onboarding/queries.ts'
import { ModelEndpoint } from '../model-endpoint-card.tsx'
import { SuggestedServers } from '../server-add.tsx'
import type { StartDraft, StartIdea } from './draft.ts'
import { SuggestedAccess } from './connect-server.tsx'

/** Each step's name on the panel, its title, and the one line of why. */
export const STEP_TEXT: Readonly<Record<OnboardingStep, { label: string; title: string; why: string }>> = {
  welcome: {
    label: 'Your goal',
    title: 'What would you like help with?',
    why: 'Start with one useful outcome. You can refine the channel and add connections as you go.',
  },
  model: {
    label: 'Model',
    title: 'A model, ready to help',
    why: 'Use the available model or connect your own. You can change this later.',
  },
  services: {
    label: 'Services',
    title: 'Connect what this goal needs',
    why: 'Optional. Start without connections, or add a useful service and choose which tools goblin can use.',
  },
  goblin: {
    label: 'First conversation',
    title: 'Your first conversation',
    why: 'Give this work a channel and review your first message. Goblin will start helping right away.',
  },
}

/** What goblin is, in three pieces: goblin itself, the model it thinks with, and the services it reaches. */
export function WelcomeStep({
  goal,
  onChange,
  onPick,
  onContinue,
}: {
  readonly goal: string
  readonly onChange: (goal: string) => void
  readonly onPick: (idea: StartIdea) => void
  readonly onContinue: () => void
}) {
  const field = useId()
  return (
    <div className="start-action">
      <label className="sr-only" htmlFor={field}>
        What would you like help with?
      </label>
      <div className="start-kickoff">
        <Textarea
          id={field}
          rows={4}
          maxLength={2000}
          value={goal}
          placeholder="I’m moving to Lisbon in March and…"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <div className="start-ideas">
        {IDEAS.map((idea) => (
          <button key={idea.label} type="button" className="start-idea" onClick={() => onPick(idea)}>
            {idea.label}
          </button>
        ))}
      </div>
      <Button size="cta" disabled={goal.trim() === ''} onClick={onContinue}>
        Continue
      </Button>
      <p className="start-note">Your own agent, with a separate channel for each thing you’re working on.</p>
    </div>
  )
}

/** Where model calls go, as Settings shows it: this deployment's models, or the owner's own endpoint and key. */
export function ModelStep() {
  return (
    <div className="start-action start-model">
      <QueryBoundary action="read where your model calls go" pending={<Skeleton className="h-10 w-full" />}>
        <ModelEndpoint progressive />
      </QueryBoundary>
      <p className="start-note">You can change it any time in Settings.</p>
    </div>
  )
}

/**
 * The servers we suggest. One that needs a sign-in comes back here (`connected`, the callback's connection); either way
 * the one just connected offers its suggested access.
 */
export function ServicesStep({
  connected,
  featured,
}: {
  readonly connected: string | undefined
  readonly featured: readonly ServerGroup[]
}) {
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
          <SuggestedServers
            featured={featured}
            preview
            connectWith={connectWith}
            onChanged={setMessage}
            onMessage={setMessage}
          />
        </QueryBoundary>
        {message !== '' && <p className="start-note">{message}</p>}
        <p className="start-note">Add any other MCP server by its address in Connections.</p>
      </div>
    </div>
  )
}

/** Ideas to start from: tapping one fills the goal, names the channel and picks the services suggested first. */
const IDEAS: readonly (StartIdea & { readonly label: string })[] = [
  {
    label: 'Plan a trip',
    goal: 'Plan a trip and keep every booking in one place',
    channel: 'Travel plans',
    groups: ['travel', 'yours'],
  },
  {
    label: 'Research a topic',
    goal: 'Research a topic and write up what I should know',
    channel: 'Research',
    groups: ['knowledge', 'code', 'yours'],
  },
  {
    label: 'Track my training',
    goal: 'Track my training and nudge me when I slack',
    channel: 'Training',
    groups: ['yours', 'knowledge'],
  },
]

export function GoblinStep({
  pending,
  draft,
  onChange,
  onStart,
}: {
  readonly pending: boolean
  readonly draft: StartDraft
  readonly onChange: (change: Partial<Pick<StartDraft, 'goal' | 'channel'>>) => void
  readonly onStart: () => void
}) {
  const field = useId()
  return (
    <div className="start-action">
      <label className="start-field">
        <span>Channel name</span>
        <Input
          maxLength={80}
          value={draft.channel}
          disabled={pending || draft.operation !== ''}
          onChange={(event) => onChange({ channel: event.target.value })}
        />
      </label>
      <label className="start-field" htmlFor={field}>
        Your first message
      </label>
      <div className="start-kickoff">
        <Textarea
          id={field}
          rows={4}
          maxLength={2000}
          value={draft.goal}
          disabled={pending || draft.operation !== ''}
          onChange={(event) => onChange({ goal: event.target.value })}
        />
      </div>
      <Button
        size="cta"
        disabled={draft.goal.trim() === '' || draft.channel.trim() === ''}
        pending={pending}
        onClick={onStart}
      >
        {draft.operation === '' ? 'Start conversation' : 'Continue starting conversation'}
      </Button>
      <p className="start-note">
        A channel keeps the conversation, its files and its instructions together. Add Personas when another perspective
        would help.
      </p>
    </div>
  )
}
