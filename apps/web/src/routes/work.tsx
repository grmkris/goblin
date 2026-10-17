import { createFileRoute } from '@tanstack/react-router'
import { agentAppsQuery } from '../agent-apps/queries.ts'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { WorkPage } from '../components/shell/pages/work-page.tsx'
import { primeOwnerRead } from '../lib/prime.ts'
import { routineSettingsQuery, routinesQuery } from '../routines/queries.ts'

/**
 * What is running and what is scheduled: the Delegates and Persona answers come from the workspace feed; the loader
 * primes the routines and the built apps' schedules.
 */
export const Route = createFileRoute('/work')({
  loader: async ({ context }) => {
    await Promise.all([
      primeOwnerRead(context.queryClient, routinesQuery),
      primeOwnerRead(context.queryClient, routineSettingsQuery),
      primeOwnerRead(context.queryClient, agentAppsQuery),
    ])
  },
  component: WorkRoute,
})
function WorkRoute() {
  return (
    <OwnerGate>
      <PageBar title="Work" />
      <div className="shell">
        <WorkPage />
      </div>
    </OwnerGate>
  )
}
