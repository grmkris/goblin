// The Settings card about the workspace itself (ADR 0089): its name and address, and deleting it.
import { type SubmitEvent, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { WorkspaceView } from '@goblin/contracts'
import { Conflict } from '@goblin/contracts/api'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Skeleton,
} from '@goblin/ui'
import { deleteWorkspaceMutation, updateWorkspaceMutation, workspacesQuery } from '../account/queries.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'
import { currentSlug, inWorkspace } from '../lib/workspace-path.ts'

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/u

/** Its name and address, for an owner or admin; a new address opens the workspace there, since links used the old. */
function Naming({ workspace }: { readonly workspace: WorkspaceView }) {
  const update = useMutation(updateWorkspaceMutation)
  const [name, setName] = useState(workspace.name)
  const [slug, setSlug] = useState(workspace.slug)
  const managing = workspace.role !== 'member'
  const changed = name.trim() !== workspace.name || slug !== workspace.slug
  const valid = name.trim() !== '' && (slug === workspace.slug || SLUG.test(slug))
  const failure =
    update.error === null
      ? ''
      : update.error instanceof Conflict && update.error.reason === 'slug'
        ? withRef('Another workspace has that address.', update.error)
        : messageOf(update.error, 'save the workspace')
  function save(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!changed || !valid) return
    update.mutate(
      {
        workspaceId: workspace.id,
        ...(name.trim() === workspace.name ? {} : { name: name.trim() }),
        ...(slug === workspace.slug ? {} : { slug }),
      },
      {
        onSuccess: (saved) => {
          if (saved.slug !== workspace.slug) window.location.assign(inWorkspace(saved.slug, '/settings'))
        },
      },
    )
  }
  return (
    <form onSubmit={save}>
      <FieldGroup>
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="workspace-settings-name">Name</FieldLabel>
          <Input
            id="workspace-settings-name"
            value={name}
            maxLength={64}
            disabled={!managing}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="workspace-settings-slug">Address</FieldLabel>
          <Input
            id="workspace-settings-slug"
            value={slug}
            maxLength={40}
            spellCheck={false}
            disabled={!managing}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
          />
          <FieldDescription>
            Its pages live at <code>{`${window.location.origin}/w/${slug}`}</code>. Changing it breaks links that used
            the old one; API keys and connected clients do not use it.
          </FieldDescription>
        </Field>
        {managing && (
          <Field orientation="horizontal">
            <Button type="submit" disabled={!changed || !valid} pending={update.isPending}>
              Save
            </Button>
          </Field>
        )}
      </FieldGroup>
    </form>
  )
}

/** Deleting it, for its owner: they type its name first. */
function Deletion({ workspace }: { readonly workspace: WorkspaceView }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const deleting = useMutation(deleteWorkspaceMutation)
  // A deleted workspace is leaving for home, so the button stays busy.
  const pending = deleting.isPending || deleting.isSuccess
  const failure = deleting.error === null ? '' : messageOf(deleting.error, 'delete the workspace')
  function remove(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (typed !== workspace.name) return
    deleting.mutate(workspace.id, { onSuccess: () => window.location.assign('/') })
  }
  if (!open)
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Delete workspace…
      </Button>
    )
  return (
    <form onSubmit={remove}>
      <FieldGroup>
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="workspace-delete-name">Type {workspace.name} to delete it</FieldLabel>
          <Input
            id="workspace-delete-name"
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
        <Field orientation="horizontal">
          <Button type="submit" variant="destructive" disabled={typed !== workspace.name} pending={pending}>
            Delete this workspace
          </Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

/** The workspace this page is in: its name and address, and for its owner, deleting it. */
export function WorkspaceCard() {
  const workspaces = useQuery(workspacesQuery)
  const slug = currentSlug()
  const workspace = workspaces.data?.find((each) => each.slug === slug)
  return (
    <Card>
      <CardHeader>
        <CardTitle>This workspace</CardTitle>
        <CardDescription>
          A workspace has its own agent: its connections, memory, channels, Personas, routines and API keys.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-6">
          {workspaces.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{messageOf(workspaces.error, 'read the workspace')}</AlertDescription>
            </Alert>
          ) : workspace === undefined ? (
            <Skeleton className="h-24" />
          ) : (
            <>
              <Naming key={`${workspace.name}:${workspace.slug}`} workspace={workspace} />
              {workspace.role === 'owner' && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-muted-foreground">
                    Deleting it erases its agent with its conversations, connections, files and keys. This cannot be
                    undone.
                  </p>
                  <Deletion workspace={workspace} />
                </div>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
