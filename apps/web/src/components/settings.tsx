import { ClientsCard, DeleteAccountCard } from './account-cards.tsx'
import { ApiKeysCard } from './api-keys-card.tsx'
import { MemoryCard, ResidentCard, UsageCard } from './agent-cards.tsx'
import { ModelEndpointCard } from './model-endpoint-card.tsx'
import { NotifySinkCard } from './notify-sink-card.tsx'
import { PageSection } from './page-section.tsx'
import { SetupSettingsCard } from './start/setup-cards.tsx'
import { WorkspaceCard } from './workspace-cards.tsx'

/**
 * The workspace's settings, most used first: today's usage, Start and the model, its agent (and where its notices go),
 * the clients connected to it, the API keys of servers it runs, the workspace itself (ADR 0089), and last the person's
 * account. Routines are on Work.
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
        title="Connected clients"
        note={
          <>
            External MCP clients you allowed to use this workspace at <code>{`${window.location.origin}/mcp`}</code>{' '}
            (each one asks which workspace when you sign it in). Revoking one ends its access at once.
          </>
        }
      >
        <ClientsCard />
      </PageSection>
      <PageSection
        id="keys"
        title="API keys"
        note={
          <>
            For servers this workspace runs: <code>Authorization: Bearer gbk_…</code> on{' '}
            <code>{`${window.location.origin}/api`}</code> or <code>/mcp</code>; a key reaches only this workspace.
            Revoking one ends it at once.
          </>
        }
      >
        <ApiKeysCard />
      </PageSection>
      <PageSection id="workspace" title="Workspace">
        <WorkspaceCard />
      </PageSection>
      <PageSection id="account" title="Account">
        <DeleteAccountCard />
      </PageSection>
    </div>
  )
}
