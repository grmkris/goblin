import { ClientsCard, DeleteAccountCard } from './account-cards.tsx'
import { DeveloperAppsCard, InstalledAppsCard } from './apps-cards.tsx'
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
 * the apps installed in it and the apps and scripts it registered (ADRs 0118, 0120), the workspace itself (ADR 0089),
 * then the person's own: the MCP clients they connected and each one's grant (ADR 0114), and their account. Routines
 * are on Work.
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
      {managing && (
        <PageSection id="installed" title="Installed apps">
          <InstalledAppsCard workspace={workspace} />
        </PageSection>
      )}
      {managing && (
        <PageSection
          id="developer"
          title="Developer"
          note={
            <>
              Register a product that workspaces install, or a script app: how a script, a server or CI of this
              workspace calls goblin. Its backend gets a token from{' '}
              <code>{`${window.location.origin}/api/auth/oauth2/token`}</code> with its client id and secret
              (client_credentials), or a shell from <code>goblin token</code> with <code>GOBLIN_CLIENT_ID</code> and{' '}
              <code>GOBLIN_CLIENT_SECRET</code> set, and calls <code>{`${window.location.origin}/w/<slug>/api`}</code>{' '}
              or <code>/mcp</code>.
            </>
          }
        >
          <DeveloperAppsCard workspace={workspace} />
        </PageSection>
      )}
      <PageSection id="workspace" title="Workspace">
        <WorkspaceCard />
        {workspace !== undefined && <MembersCard workspace={workspace} />}
      </PageSection>
      <PageSection
        id="clients"
        title="Connected clients"
        note={
          <>
            External MCP clients you allowed to use goblin at <code>{`${window.location.origin}/mcp`}</code>, each with
            the access you gave it: a level, the workspaces and what in each it reaches, and its extras. They are yours,
            whichever workspace you are in; a change applies at once, and revoking one ends its access.
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
