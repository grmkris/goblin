import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { WorkspaceView } from '@goblin/contracts'
import { Conflict } from '@goblin/contracts/api'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  GoblinMark,
  Input,
} from '@goblin/ui'
import { CheckIcon, ChevronsUpDownIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { createWorkspaceMutation, workspacesQuery } from '../../account/queries.ts'
import { rememberWorkspace } from '../../lib/last-workspace.ts'
import { messageOf, withRef } from '../../lib/query/app-error.ts'
import { currentSlug, inWorkspace } from '../../lib/workspace-path.ts'
import { EXACT, Tip } from './sidebar-parts.tsx'

/** A workspace's address from its name: lowercase letters and digits, single hyphens, at most 40 characters. */
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replaceAll(/-+$/gu, '')

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/u

/** Opens `workspace` in this tab: a page load of its own, so nothing of this workspace's stays in memory. */
const open = (workspace: WorkspaceView, path = '/'): void => window.location.assign(inWorkspace(workspace.slug, path))

/** What the person reads when a workspace could not be made so. */
function refusal(failure: unknown): string {
  if (failure instanceof Conflict && failure.reason === 'slug')
    return withRef('Another workspace has that address.', failure)
  return messageOf(failure, 'create the workspace')
}

/**
 * A new workspace (ADR 0089): a name and the address its pages use, from the name until the person changes it. It
 * opens on Start, where its agent is set up.
 */
function CreateWorkspace({
  open: shown,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const create = useMutation(createWorkspaceMutation)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState<string | undefined>(undefined)
  const address = slug ?? slugOf(name)
  const valid = name.trim() !== '' && SLUG.test(address)
  // expected: the dialog stays open and shows the refusal (an address in use) under the address
  const error = create.error === null ? '' : refusal(create.error)
  function submit(): void {
    if (!valid || create.isPending) return
    create.mutate({ name: name.trim(), slug: address }, { onSuccess: (made) => open(made, '/start/welcome') })
  }
  return (
    <Dialog open={shown} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(30rem,calc(100vw-2rem))]">
        <DialogTitle>New workspace</DialogTitle>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Field>
            <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
            <Input
              id="workspace-name"
              value={name}
              maxLength={64}
              autoComplete="off"
              autoFocus
              placeholder="e.g. Swarmm"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field data-invalid={error !== '' || undefined}>
            <FieldLabel htmlFor="workspace-slug">Address</FieldLabel>
            <Input
              id="workspace-slug"
              value={address}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error !== '' || undefined}
              onChange={(event) => setSlug(event.target.value.toLowerCase())}
            />
            <FieldDescription>Its pages live at /w/{address === '' ? '…' : address}.</FieldDescription>
            {error !== '' && <FieldError>{error}</FieldError>}
          </Field>
          <p className="text-sm text-muted-foreground">
            A workspace has its own agent: its own connections, memory, channels and keys.
          </p>
          <div className="flex justify-end gap-2">
            <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid || create.isPending}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The sidebar's head (ADR 0089): the workspace this page is in, and a menu of the person's others, a new one and this
 * one's settings. Choosing another opens it in this tab; each tab can be in a different one.
 */
export function WorkspaceMenu() {
  const workspaces = useQuery(workspacesQuery)
  const [creating, setCreating] = useState(false)
  const slug = currentSlug()
  const current = workspaces.data?.find((workspace) => workspace.slug === slug)
  useEffect(() => rememberWorkspace(window.location.pathname), [])
  return (
    <>
      <DropdownMenu>
        <Tip label={current?.name ?? 'Workspace'}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="sidebar-brand"
                aria-label={`Workspace: ${current?.name ?? slug ?? ''}`}
              />
            }
          >
            <GoblinMark />
            <span className="sidebar-title">{current?.name ?? 'goblin'}</span>
            <ChevronsUpDownIcon className="sidebar-title-chevron" aria-hidden />
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent side="bottom" align="start">
          {(workspaces.data ?? []).map((workspace) => (
            <DropdownMenuItem key={workspace.id} onClick={() => workspace.slug !== slug && open(workspace)}>
              {workspace.slug === slug ? <CheckIcon aria-hidden /> : <span className="size-4" aria-hidden />}
              {workspace.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreating(true)}>
            <PlusIcon aria-hidden />
            New workspace
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link activeOptions={EXACT} to="/settings" hash="workspace" />}>
            <SettingsIcon aria-hidden />
            Workspace settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {creating && <CreateWorkspace open={creating} onOpenChange={setCreating} />}
    </>
  )
}
