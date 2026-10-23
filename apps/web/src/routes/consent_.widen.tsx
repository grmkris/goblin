import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { Widen } from '../components/widen.tsx'
import { parseWiden } from '../lib/widen.ts'

/**
 * The widening page (ADR 0114): a credential refused for want of access links here, naming its grant and what it
 * lacked, and the person who may approve it compares and decides.
 */
export const Route = createFileRoute('/consent_/widen')({ validateSearch: parseWiden, component: WidenPage })
function WidenPage() {
  const search = Route.useSearch()
  return (
    <OwnerGate>
      <Widen search={search} />
    </OwnerGate>
  )
}
