import { createFileRoute } from '@tanstack/react-router'
import { agentAppsQuery } from '../agent-apps/queries.ts'
import { AppsPage } from '../components/apps-page.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { primeOwnerRead } from '../lib/prime.ts'
import { serversQuery } from '../mcp/queries.ts'

/** Apps (ADR 0078): the built apps and the connections start loading before the page renders. */
export const Route = createFileRoute('/apps/')({
  loader: async ({ context }) => {
    await Promise.all([
      primeOwnerRead(context.queryClient, agentAppsQuery),
      primeOwnerRead(context.queryClient, serversQuery),
    ])
  },
  component: AppsRoute,
})
function AppsRoute() {
  return (
    <OwnerGate>
      <PageBar title="Apps" />
      <div className="shell launcher-shell">
        <AppsPage />
      </div>
    </OwnerGate>
  )
}
