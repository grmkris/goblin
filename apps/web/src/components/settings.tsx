import { ClientsCard, DeleteAccountCard } from './account-cards.tsx'
import { MemoryCard, ResidentCard, UsageCard } from './agent-cards.tsx'
import { ModelEndpointCard } from './model-endpoint-card.tsx'
import { NotifySinkCard } from './notify-sink-card.tsx'
import { PageSection } from './page-section.tsx'
import { SetupSettingsCard } from './start/setup-cards.tsx'

/**
 * The owner's settings, most used first: today's usage, Start and the model, their agent (and where its notices go),
 * the apps that use their agent, and last the account itself. Routines are on Work.
 */
export function Settings() {
  return (
    <div className="page-stack">
      <PageSection id="usage" title="Usage and model">
        <SetupSettingsCard />
        <UsageCard />
        <ModelEndpointCard />
      </PageSection>
      <PageSection id="agent" title="Your agent">
        <ResidentCard />
        <MemoryCard />
        <NotifySinkCard />
      </PageSection>
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
