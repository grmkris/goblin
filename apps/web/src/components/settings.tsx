import { ClientsCard, DeleteAccountCard } from './account-cards.tsx'
import { MemoryCard, ResidentCard, UsageCard } from './agent-cards.tsx'
import { PageSection } from './page-section.tsx'
import { RoutinesSection } from './routines.tsx'
import { SetupSettingsCard } from './start/setup-cards.tsx'

/**
 * The owner's settings, most used first: today's usage and Start, their agent, routines, the apps that use their
 * agent, and last the account itself.
 */
export function Settings() {
  return (
    <div className="page-stack">
      <PageSection id="usage" title="Usage">
        <SetupSettingsCard />
        <UsageCard />
      </PageSection>
      <PageSection id="agent" title="Your agent">
        <ResidentCard />
        <MemoryCard />
      </PageSection>
      <RoutinesSection />
      <PageSection
        id="clients"
        title="Apps that use your agent"
        note={
          <>
            MCP clients you allowed to use goblin at <code>{`${window.location.origin}/mcp`}</code>.
          </>
        }
      >
        <ClientsCard />
      </PageSection>
      <PageSection id="account" title="Account">
        <DeleteAccountCard />
      </PageSection>
    </div>
  )
}
