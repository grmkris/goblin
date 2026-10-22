import { useQuery } from '@tanstack/react-query'
import type { WorkspaceView } from '@goblin/contracts'
import { workspacesQuery } from '../account/queries.ts'
import { currentSlug } from './workspace-path.ts'

/**
 * Whether the person may change what this workspace's agent works with here (ADR 0098): Personas, a Topic's guidance
 * and setup, routines. An owner's or admin's; until the list is read it shows as theirs, and the agent refuses a member's
 * change anyway.
 */
export function useConfigures(): boolean {
  return useCurrentWorkspace()?.role !== 'member'
}

/** The workspace this page is in, with the person's role in it (ADR 0089); none while the list is read. */
export function useCurrentWorkspace(): WorkspaceView | undefined {
  const workspaces = useQuery(workspacesQuery)
  const slug = currentSlug()
  return workspaces.data?.find((workspace) => workspace.slug === slug)
}
