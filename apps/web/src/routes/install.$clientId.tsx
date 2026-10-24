import { createFileRoute } from '@tanstack/react-router'
import { Install } from '../components/install.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'

/** The install page an app links to (ADR 0118): a workspace's owner or admin installs it there with a grant. */
export const Route = createFileRoute('/install/$clientId')({ component: InstallPage })
function InstallPage() {
  const { clientId } = Route.useParams()
  return (
    <OwnerGate>
      <Install clientId={clientId} />
    </OwnerGate>
  )
}
