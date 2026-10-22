import { ClientsCard, DeleteAccountCard } from './account-cards.tsx'
import { ApiKeysCard } from './api-keys-card.tsx'
import { MemoryCard, ResidentCard, UsageCard } from './agent-cards.tsx'
import { ModelEndpointCard } from './model-endpoint-card.tsx'
import { NotifySinkCard } from './notify-sink-card.tsx'
import { PageSection } from './page-section.tsx'
import { SetupSettingsCard } from './start/setup-cards.tsx'
import { MembersCard } from './members-card.tsx'
import { WorkspaceCard } from './workspace-cards.tsx'
import { useCurrentWorkspace } from '../lib/current-workspace.ts'

/**
 * The workspace's settings, most used first: today's usage, Start and the model, its agent (and where its notices go),
 * the API keys of servers it runs, the workspace itself (ADR 0089), then the person's own: the MCP clients they
 * connected and the workspaces each reaches (ADR 0097), and their account. Routines are on Work.
 */
export function Settings() {
  const workspace = useCurrentWorkspace()
  // What the agent may do is its owners' and admins' to change (ADR 0093); a member sees what is theirs.
  const managing = workspace !== undefined && workspace.role !== 'member'
  return (
    <div className="page-stack">
      <PageSection id="usage" title="Usage and model">
        {managing && <SetupSettingsCard />}
        <UsageCard />
        {managing && <ModelEndpointCard />}
      </PageSection>
      <PageSection id="agent" title="Your agent">
        {managing && <ResidentCard />}
        <MemoryCard />
        {managing && <NotifySinkCard />}
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
        {managing ? (
          <ApiKeysCard />
        ) : (
          <p className="text-sm text-muted-foreground">Only the workspace's owners and admins make keys.</p>
        )}
      </PageSection>
      <PageSection id="workspace" title="Workspace">
        <WorkspaceCard />
        {workspace !== undefined && <MembersCard workspace={workspace} />}
      </PageSection>
      <PageSection
        id="clients"
        title="Connected clients"
        note={
          <>
            External MCP clients you allowed to use goblin at <code>{`${window.location.origin}/mcp`}</code>, each
            reaching the workspaces you chose, or all of yours. They are yours, whichever workspace you are in; revoking
            one ends its access at once.
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
