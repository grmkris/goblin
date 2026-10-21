import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Button } from '@goblin/ui'
import { workspacesQuery } from '../account/queries.ts'
import { currentSlug } from '../lib/workspace-path.ts'
import { AuthShell } from './auth-shell.tsx'

/**
 * `children` when the page's workspace is one of the person's (ADR 0089); otherwise a page that says it is not theirs
 * and opens their own, rather than a shell whose every read is refused. While their list is still read, or before they
 * are known to be signed in (`signedIn`), `children`.
 */
export function YourWorkspace({ signedIn, children }: { readonly signedIn: boolean; readonly children: ReactNode }) {
  const workspaces = useQuery({ ...workspacesQuery, enabled: signedIn })
  const slug = currentSlug()
  const listed = workspaces.data
  if (slug === undefined || listed === undefined || listed.some((workspace) => workspace.slug === slug)) return children
  return (
    <main className="shell">
      <AuthShell
        title="This workspace is not one of yours"
        description="No workspace you belong to lives at this address. Its link may be old, or someone else's."
      >
        <div className="auth-body">
          <Button onClick={() => window.location.assign('/')}>Open your workspace</Button>
        </div>
      </AuthShell>
    </main>
  )
}
