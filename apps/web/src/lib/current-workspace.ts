import { useQuery } from '@tanstack/react-query'
import type { WorkspaceView } from '@goblin/contracts'
import { workspacesQuery } from '../account/queries.ts'
import { currentSlug } from './workspace-path.ts'

/** The workspace this page is in, with the person's role in it (ADR 0089); none while the list is read. */
export function useCurrentWorkspace(): WorkspaceView | undefined {
  const workspaces = useQuery(workspacesQuery)
  const slug = currentSlug()
  return workspaces.data?.find((workspace) => workspace.slug === slug)
}
