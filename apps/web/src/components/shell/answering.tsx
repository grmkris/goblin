import type { PersonaInvocationView } from '@goblin/contracts'
import type { LiveChild } from '../../lib/agui/reducer.ts'
import { useInvocations, usePersonas } from '../../lib/workspace/hooks.ts'
import { PersonaAvatar } from '../persona-avatar.tsx'

const byOrder = (a: PersonaInvocationView, b: PersonaInvocationView) => a.order - b.order || a.persona - b.persona

/**
 * Who still works in a chat, one row each after its transcript, until its answer arrives in it: a Persona answering in
 * its fork or a subagent at work, "answering…" or "working…", while the chat's stream carries it (`working`, from its
 * SUBAGENT_* lifecycle), and a Persona asked in sequence "waiting…" its turn, which only the workspace feed knows of.
 */
export function Answering({ chat, working }: { readonly chat: string; readonly working: readonly LiveChild[] }) {
  const invocations = useInvocations()
  const all = usePersonas()
  const waiting = invocations.filter((each) => each.chat === chat && each.state === 'pending').toSorted(byOrder)
  if (working.length === 0 && waiting.length === 0) return null
  const personas = new Map(all.map((persona) => [persona.id, persona]))
  return (
    <div className="answering" aria-live="polite">
      {working.map((child) => (
        <p key={child.id} className="answering-row">
          {child.persona !== undefined && <PersonaAvatar avatar={child.persona.avatar} size="sm" />}
          <b>{child.name}</b>
          <span data-state="running">{child.persona === undefined ? 'working…' : 'answering…'}</span>
        </p>
      ))}
      {waiting.map((invocation) => {
        const persona = personas.get(invocation.persona)
        return (
          <p key={`${invocation.operationId}:${invocation.persona}`} className="answering-row">
            {persona !== undefined && <PersonaAvatar avatar={persona.avatar} size="sm" />}
            <b>{persona?.name ?? 'A persona'}</b>
            <span data-state="pending">waiting…</span>
          </p>
        )
      })}
    </div>
  )
}
