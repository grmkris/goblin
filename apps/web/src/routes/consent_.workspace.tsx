import { createFileRoute } from '@tanstack/react-router'
import { ConsentWorkspace } from '../components/consent-workspace.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'

/** An MCP client's sign-in asks which workspace it is for, before its consent (ADR 0089). */
export const Route = createFileRoute('/consent_/workspace')({ component: ConsentWorkspacePage })
function ConsentWorkspacePage() {
  return (
    <OwnerGate>
      <ConsentWorkspace />
    </OwnerGate>
  )
}
