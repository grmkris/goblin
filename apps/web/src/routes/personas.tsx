import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { PersonasPage } from '../components/shell/pages/personas-page.tsx'

/** The owner's Personas (ADR 0078): read from the workspace feed, each opening its profile. */
export const Route = createFileRoute('/personas')({ component: PersonasRoute })
function PersonasRoute() {
  return (
    <OwnerGate>
      <PageBar title="Personas" />
      <div className="shell">
        <PersonasPage />
      </div>
    </OwnerGate>
  )
}
