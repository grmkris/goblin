import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { PersonaView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { ChevronRightIcon, PlusIcon } from 'lucide-react'
import { activePersonas } from '../../../lib/personas.ts'
import { usePersonas } from '../../../lib/workspace/hooks.ts'
import { PageSection } from '../../page-section.tsx'
import { PersonaAvatar } from '../../persona-avatar.tsx'
import { RowContents } from './chat-link.tsx'

/** One Persona: its mark, `@name` and role; the row opens its profile to edit it (never a chat with it). */
function PersonaRow({ persona }: { readonly persona: PersonaView }) {
  return (
    <li>
      <Link to="/p/$id" params={{ id: String(persona.id) }} className="list-row">
        <RowContents
          mark={<PersonaAvatar avatar={persona.avatar} size="sm" />}
          title={`@${persona.name}`}
          meta={persona.role}
          end={<span className="list-row-action">Edit</span>}
        />
      </Link>
    </li>
  )
}

/** The archived Personas, folded under one line until asked for. */
function Archived({ personas }: { readonly personas: readonly PersonaView[] }) {
  const [open, setOpen] = useState(false)
  if (personas.length === 0) return null
  return (
    <section className="page-section">
      <button type="button" className="list-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRightIcon aria-hidden />
        Archived ({personas.length})
      </button>
      {open && (
        <ul className="list-rows">
          {personas.map((persona) => (
            <PersonaRow key={persona.id} persona={persona} />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * `/personas` (ADR 0078): the specialists the owner calls into a conversation with `@name`, by name, each opening its
 * profile to edit; the archived folded at the end.
 */
export function PersonasPage() {
  const personas = usePersonas()
  const active = activePersonas(personas)
  const archived = personas.filter((persona) => persona.archivedAt !== undefined)
  return (
    <div className="page-stack">
      <PageSection
        id="personas"
        title="Personas"
        count={active.length}
        note="Call a Persona into any conversation with @ and its name. It answers there, with what its setup adds."
        action={
          <Button size="sm" variant="outline" nativeButton={false} render={<Link to="/p/$id" params={{ id: 'new' }} />}>
            <PlusIcon aria-hidden />
            Add persona
          </Button>
        }
      >
        {active.length === 0 ? (
          <p className="page-empty">No personas yet.</p>
        ) : (
          <ul className="list-rows">
            {active.map((persona) => (
              <PersonaRow key={persona.id} persona={persona} />
            ))}
          </ul>
        )}
      </PageSection>
      <Archived personas={archived} />
    </div>
  )
}
