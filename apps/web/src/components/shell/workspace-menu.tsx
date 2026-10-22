import { use, useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { InvitationPreview, WorkspaceView } from '@goblin/contracts'
import { Conflict } from '@goblin/contracts/api'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  GoblinMark,
  Input,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@goblin/ui'
import { CheckIcon, ChevronsUpDownIcon, MailIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { useAnswerInvitation, useMyInvitations } from '../../account/hooks.ts'
import { createWorkspaceMutation, workspacesQuery } from '../../account/queries.ts'
import { ROLE_PHRASE, ROLE_WORDS } from '../../lib/labels.ts'
import { rememberWorkspace } from '../../lib/last-workspace.ts'
import { messageOf, withRef } from '../../lib/query/app-error.ts'
import { currentSlug, inWorkspace } from '../../lib/workspace-path.ts'
import { invitationRefusal } from '../invitation-refusal.ts'
import { EXACT, Strip } from './sidebar-parts.tsx'

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

/** How many invitations wait, in words. */
const waiting = (count: number): string => `${String(count)} ${count === 1 ? 'invitation' : 'invitations'} waiting`

/**
 * One invitation at the top of the menu (ADR 0093): its workspace and who invited, which opens the invitation's page,
 * then No thanks and Join, which answer it in place and keep the menu open. A refusal shows under it, whole.
 */
function InvitationItem({ invitation }: { readonly invitation: InvitationPreview }) {
  const answer = useAnswerInvitation(invitation.id)
  const busy = answer.joining || answer.declining
  return (
    <DropdownMenuGroup aria-label={invitation.workspace}>
      <div className="workspace-invite">
        <DropdownMenuItem render={<Link to="/invite/$id" params={{ id: invitation.id }} />}>
          <MailIcon aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{invitation.workspace}</span>
            <span className="truncate text-xs text-muted-foreground">
              From {invitation.invitedBy}, as {ROLE_PHRASE[invitation.role]}
            </span>
          </span>
        </DropdownMenuItem>
        <span className="workspace-invite-answers">
          <DropdownMenuItem closeOnClick={false} disabled={busy} onClick={answer.decline}>
            {answer.declining && <Spinner aria-hidden role={undefined} />}
            No thanks
          </DropdownMenuItem>
          <DropdownMenuItem variant="moss" closeOnClick={false} disabled={busy} onClick={answer.join}>
            {answer.joining && <Spinner aria-hidden role={undefined} />}
            Join
          </DropdownMenuItem>
        </span>
        {answer.failure !== null && (
          <p className="workspace-invite-refusal" role="alert">
            {invitationRefusal(answer.failure, invitation)}
          </p>
        )}
      </div>
    </DropdownMenuGroup>
  )
}

/**
 * The sidebar's head (ADR 0089): the workspace this page is in, with a moss count while invitations wait for the
 * person (ADR 0093), and a menu of those invitations first, each answered in place, then the person's workspaces with
 * their role in each, a new one and this one's settings. Choosing another opens it in this tab; each tab can be in a
 * different one. Its tooltip names the workspace and the person's role in it.
 */
export function WorkspaceMenu() {
  const workspaces = useQuery(workspacesQuery)
  const invitations = useMyInvitations()
  const [creating, setCreating] = useState(false)
  const strip = use(Strip)
  const slug = currentSlug()
  const current = workspaces.data?.find((workspace) => workspace.slug === slug)
  useEffect(() => rememberWorkspace(window.location.pathname), [])
  const where = current === undefined ? undefined : `You are ${ROLE_PHRASE[current.role]} of ${current.name}`
  const label = [
    `Workspace: ${current?.name ?? slug ?? ''}`,
    ...(current === undefined ? [] : [`you are ${ROLE_PHRASE[current.role]}`]),
    ...(invitations.length > 0 ? [waiting(invitations.length)] : []),
  ].join(', ')
  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger render={<button type="button" className="sidebar-brand" aria-label={label} />}>
                <GoblinMark />
                <span className="sidebar-title">{current?.name ?? 'goblin'}</span>
                {invitations.length > 0 && (
                  <span className="sidebar-invites" aria-hidden>
                    {invitations.length > 9 ? '9+' : invitations.length}
                  </span>
                )}
                <ChevronsUpDownIcon className="sidebar-title-chevron" aria-hidden />
              </DropdownMenuTrigger>
            }
          />
          <TooltipContent side={strip ? 'right' : 'bottom'} align={strip ? 'center' : 'start'}>
            {where ?? current?.name ?? 'Workspace'}
            {invitations.length > 0 && <span className="block opacity-75">{waiting(invitations.length)}</span>}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="bottom" align="start">
          {invitations.length > 0 && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Invitations</DropdownMenuLabel>
                {invitations.map((invitation) => (
                  <InvitationItem key={invitation.id} invitation={invitation} />
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          {(workspaces.data ?? []).map((workspace) => (
            <DropdownMenuItem key={workspace.id} onClick={() => workspace.slug !== slug && open(workspace)}>
              <CheckIcon aria-hidden className={workspace.slug === slug ? undefined : 'invisible'} />
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              <span className="workspace-role">{ROLE_WORDS[workspace.role]}</span>
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
