import { createFileRoute } from '@tanstack/react-router'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { Settings } from '../components/settings.tsx'
import { clientsQuery, keysQuery } from '../account/queries.ts'
import { memoryQuery, modelEndpointQuery, residentQuery, usageQuery } from '../agent/queries.ts'
import { primeOwnerRead } from '../lib/prime.ts'

/** The settings' cards start loading before the page renders. */
export const Route = createFileRoute('/settings')({
  loader: async ({ context }) => {
    await Promise.all([
      primeOwnerRead(context.queryClient, usageQuery),
      primeOwnerRead(context.queryClient, modelEndpointQuery),
      primeOwnerRead(context.queryClient, residentQuery),
      primeOwnerRead(context.queryClient, memoryQuery()),
      primeOwnerRead(context.queryClient, clientsQuery),
      primeOwnerRead(context.queryClient, keysQuery),
    ])
  },
  component: SettingsPage,
})
function SettingsPage() {
  return (
    <OwnerGate>
      <PageBar title="Settings" />
      <div className="shell">
        <Settings />
      </div>
    </OwnerGate>
  )
}
