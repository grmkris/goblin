// The Settings cards for apps (ADR 0118): the products and scripts this workspace registered, and the apps installed in
// it, each with its grant.
import { Fragment, type SubmitEvent, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import {
  type DeveloperApp,
  GRANT_SPEC,
  type GrantTerms,
  type InstallationView,
  type WorkspaceView,
  presetFor,
} from '@goblin/contracts'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConsentSummary,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Skeleton,
  Switch,
} from '@goblin/ui'
import {
  deleteAppMutation,
  developerAppsQuery,
  installationsQuery,
  registerAppMutation,
  rotateAppMutation,
  uninstallMutation,
  updateInstallationMutation,
} from '../account/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'
import { Problem, ShownSecret } from './api-keys-card.tsx'
import {
  GRANT_WORDS,
  type GrantHolder,
  GrantEditor,
  GrantLine,
  grantFailure,
  grantProblem,
  reachWords,
} from './grant-editor.tsx'

/** Where a product sends a workspace's admin to install it: goblin's install page for its client. */
const installLink = (clientId: string): string => `${window.location.origin}/install/${encodeURIComponent(clientId)}`

/** A registered app's client id, secret (once) and, for a product, its install link: what its backend needs. */
function Registered(props: {
  readonly name: string
  readonly clientId: string
  readonly secret: string
  readonly script: boolean
  readonly onDone: () => void
}) {
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="app-client-id">Client ID</FieldLabel>
        <Input id="app-client-id" readOnly value={props.clientId} onFocus={(event) => event.currentTarget.select()} />
        <FieldDescription>
          {props.script
            ? 'Installed here already. Set GOBLIN_CLIENT_ID and GOBLIN_CLIENT_SECRET, then goblin token gives your script a token.'
            : `Its "Connect goblin" link: ${installLink(props.clientId)}`}
        </FieldDescription>
      </Field>
      <ShownSecret name={props.name} secret={props.secret} noun="app secret" onDone={props.onDone} />
    </FieldGroup>
  )
}

/** A product's own addresses: its homepage, and where an install sends the person back. */
function ProductFields(props: {
  readonly homepage: string
  readonly returnUrl: string
  readonly onHomepage: (value: string) => void
  readonly onReturnUrl: (value: string) => void
}) {
  return (
    <>
      <Field>
        <FieldLabel htmlFor="app-homepage">Homepage</FieldLabel>
        <Input
          id="app-homepage"
          type="url"
          inputMode="url"
          placeholder="https://"
          value={props.homepage}
          onChange={(event) => props.onHomepage(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="app-return">Return address</FieldLabel>
        <Input
          id="app-return"
          type="url"
          inputMode="url"
          placeholder="https://your-app/goblin/installed"
          value={props.returnUrl}
          required
          onChange={(event) => props.onReturnUrl(event.target.value)}
        />
        <FieldDescription>
          Where an install sends the person back, with installation, workspace and state.
        </FieldDescription>
      </Field>
    </>
  )
}

/** A new app's fields as the form holds them, and the registration they make. */
function useNewApp(workspace: WorkspaceView) {
  const register = useMutation(registerAppMutation)
  const [name, setName] = useState('')
  const [homepage, setHomepage] = useState('')
  const [returnUrl, setReturnUrl] = useState('')
  const [script, setScript] = useState(false)
  const [terms, setTerms] = useState<GrantTerms>(() => presetFor('app', [workspace.id]))
  const problem = grantProblem(terms)
  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    register.mutate({
      name: name.trim(),
      ...(homepage.trim() === '' ? {} : { homepage: homepage.trim() }),
      returnUrls: script ? [] : [returnUrl.trim()],
      terms: { ...terms, name: name.trim() },
      script,
    })
  }
  function reset(): void {
    register.reset()
    setName('')
    setHomepage('')
    setReturnUrl('')
    setTerms(presetFor('app', [workspace.id]))
  }
  return {
    register,
    fields: { name, homepage, returnUrl, script, terms },
    set: { name: setName, homepage: setHomepage, returnUrl: setReturnUrl, script: setScript, terms: setTerms },
    problem,
    ready: name.trim() !== '' && problem === '' && (script || returnUrl.trim() !== ''),
    submit,
    reset,
  }
}

/**
 * A new app: its name, homepage and return address (a product's), or a script app's (installed here at once), and the
 * access it asks for, which starts as the preset (write, every Topic, Persona and connection, no extras, until removed);
 * then its client id and secret, once.
 */
function NewApp(props: { readonly workspace: WorkspaceView }) {
  const { register, fields, set, problem, ready, submit, reset } = useNewApp(props.workspace)
  const holder: GrantHolder = { kind: 'key', workspace: props.workspace }
  const failure = register.error === null ? '' : grantFailure(register.error, 'register that app')
  if (register.data !== undefined)
    return (
      <Registered
        name={register.data.app.name}
        clientId={register.data.app.clientId}
        secret={register.data.clientSecret}
        script={register.data.app.script}
        onDone={reset}
      />
    )
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Problem text={failure} error={register.error} />
        <Field>
          <FieldLabel htmlFor="app-name">Name</FieldLabel>
          <Input
            id="app-name"
            value={fields.name}
            maxLength={80}
            required
            onChange={(event) => set.name(event.target.value)}
          />
        </Field>
        <Field orientation="horizontal">
          <Switch
            id="app-script"
            aria-labelledby="app-script-label"
            checked={fields.script}
            onCheckedChange={set.script}
          />
          <FieldLabel id="app-script-label" htmlFor="app-script">
            A script of this workspace's: installed here at once, no return address
          </FieldLabel>
        </Field>
        {!fields.script && (
          <ProductFields
            homepage={fields.homepage}
            returnUrl={fields.returnUrl}
            onHomepage={set.homepage}
            onReturnUrl={set.returnUrl}
          />
        )}
        <ConsentSummary
          clientName={fields.name.trim() || 'The app'}
          terms={fields.terms}
          spec={GRANT_SPEC}
          words={GRANT_WORDS}
          describeReach={reachWords(holder)}
        >
          <GrantEditor terms={fields.terms} holder={holder} onChange={set.terms} disabled={register.isPending} />
        </ConsentSummary>
        <Problem text={problem} />
        <Field orientation="horizontal">
          <Button type="submit" pending={register.isPending} disabled={!ready}>
            Register app
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

/** A new client secret for one app, once the owner confirms the old one stops working; then the new one, once. */
function RotateAppSecret(props: { readonly app: DeveloperApp; readonly onDone: () => void }) {
  const rotate = useMutation(rotateAppMutation)
  const failure = rotate.error === null ? '' : messageOf(rotate.error, 'rotate that secret')
  if (rotate.data !== undefined)
    return (
      <ShownSecret name={props.app.name} secret={rotate.data.clientSecret} noun="app secret" onDone={props.onDone} />
    )
  return (
    <FieldGroup>
      <Problem text={failure} error={rotate.error} />
      <div className="inline-confirm" role="alertdialog" aria-label={`Rotate the secret of ${props.app.name}?`}>
        <span>
          Rotate its secret? The old one stops working at once; tokens it already got last up to an hour. Its
          installations stay.
        </span>
        <Button
          size="sm"
          variant="destructive"
          pending={rotate.isPending}
          onClick={() => rotate.mutate(props.app.clientId)}
        >
          Rotate secret
        </Button>
        <Button size="sm" variant="ghost" disabled={rotate.isPending} onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </FieldGroup>
  )
}

/** The apps this workspace registered, each with what it asks for, its link, a new secret and its end. */
function DeveloperApps(props: { readonly workspace: WorkspaceView }) {
  const apps = useSuspenseQuery(developerAppsQuery).data
  const holder: GrantHolder = { kind: 'key', workspace: props.workspace }
  const remove = useMutation(deleteAppMutation)
  const [rotating, setRotating] = useState<string>()
  const deleting = remove.isPending ? remove.variables : ''
  const failure = remove.error === null ? '' : messageOf(remove.error, 'delete that app')
  return (
    <>
      <Problem text={failure} error={remove.error} />
      {apps.length === 0 && <p className="server-note">None yet.</p>}
      {apps.length > 0 && (
        <ul className="pick-list">
          {apps.map((app) => (
            <Fragment key={app.clientId}>
              <li className="pick-row flex-wrap">
                <span className="grant-text basis-64">
                  <span className="grant-name">
                    {app.name} <code className="break-all">{app.clientId}</code>
                  </span>
                  <span className="text-sm text-pretty text-muted-foreground">
                    <GrantLine name={app.script ? 'It' : 'An install'} terms={app.terms} holder={holder} />
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {app.script ? 'Script app' : `Installed in ${app.installations}`}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1">
                  {!app.script && (
                    <Button
                      variant="ghost"
                      onClick={() => void navigator.clipboard.writeText(installLink(app.clientId))}
                    >
                      Copy install link
                    </Button>
                  )}
                  <Button variant="ghost" disabled={rotating !== undefined} onClick={() => setRotating(app.clientId)}>
                    Rotate secret
                  </Button>
                  <Button
                    variant="outline"
                    pending={deleting === app.clientId}
                    disabled={(deleting !== '' && deleting !== app.clientId) || rotating === app.clientId}
                    onClick={() => remove.mutate(app.clientId)}
                  >
                    Delete
                  </Button>
                </span>
              </li>
              {rotating === app.clientId && (
                <li>
                  <RotateAppSecret app={app} onDone={() => setRotating(undefined)} />
                </li>
              )}
            </Fragment>
          ))}
        </ul>
      )}
    </>
  )
}

/** Products and scripts this workspace registers: a new one, and the list. */
export function DeveloperAppsCard(props: { readonly workspace: WorkspaceView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>New app</CardTitle>
        <CardDescription>
          An app is a product or a script that reaches goblin with its own client secret. A product is installed by each
          workspace's owner or admin from its install link; a script is installed here as it is registered.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-6">
          <NewApp workspace={props.workspace} />
          <QueryBoundary action="list your apps" pending={<Skeleton className="h-6 w-full" />}>
            <DeveloperApps workspace={props.workspace} />
          </QueryBoundary>
        </div>
      </CardContent>
    </Card>
  )
}

/** One installation's grant, changed in place: it stays the same installation. */
function InstallationGrant(props: {
  readonly installation: InstallationView
  readonly holder: GrantHolder
  readonly onDone: () => void
}) {
  const update = useMutation(updateInstallationMutation)
  const [terms, setTerms] = useState<GrantTerms>(props.installation.terms)
  const problem = grantProblem(terms)
  const failure = update.error === null ? '' : grantFailure(update.error, 'change that app')
  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    update.mutate({ id: props.installation.id, terms }, { onSuccess: props.onDone })
  }
  return (
    <form onSubmit={submit} className="pb-4">
      <FieldGroup>
        <Problem text={failure} error={update.error} />
        <GrantEditor terms={terms} holder={props.holder} onChange={setTerms} disabled={update.isPending} />
        <Problem text={problem} />
        <Field orientation="horizontal">
          <Button type="submit" pending={update.isPending} disabled={problem !== ''}>
            Save access
          </Button>
          <Button type="button" variant="ghost" disabled={update.isPending} onClick={props.onDone}>
            Cancel
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

/** Who installed an app and when, in a line. */
const installedLine = (installation: InstallationView): string =>
  [
    `from ${installation.from}`,
    installation.approvedBy === undefined ? undefined : `installed by ${installation.approvedBy}`,
    new Date(installation.createdAt).toLocaleDateString(),
  ]
    .filter((part) => part !== undefined)
    .join(' · ')

/** The apps installed here, each with its grant in a line, changeable and removable. */
function Installations(props: { readonly workspace: WorkspaceView }) {
  const installations = useSuspenseQuery(installationsQuery).data
  const holder: GrantHolder = { kind: 'key', workspace: props.workspace }
  const uninstall = useMutation(uninstallMutation)
  const [editing, setEditing] = useState<string>()
  const removing = uninstall.isPending ? uninstall.variables : ''
  const failure = uninstall.error === null ? '' : messageOf(uninstall.error, 'uninstall that app')
  return (
    <>
      <Problem text={failure} error={uninstall.error} />
      {installations.length === 0 && <p className="server-note">None yet.</p>}
      {installations.length > 0 && (
        <ul className="pick-list">
          {installations.map((installation) => (
            <Fragment key={installation.id}>
              <li className="pick-row flex-wrap">
                <span className="grant-text basis-64">
                  <span className="grant-name">{installation.name}</span>
                  <span className="text-sm text-pretty text-muted-foreground">
                    <GrantLine name="It" terms={installation.terms} holder={holder} />
                  </span>
                  <span className="text-xs text-muted-foreground">{installedLine(installation)}</span>
                </span>
                <span className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    disabled={editing === installation.id}
                    onClick={() => setEditing(installation.id)}
                  >
                    Change access
                  </Button>
                  <Button
                    variant="outline"
                    pending={removing === installation.id}
                    disabled={removing !== '' && removing !== installation.id}
                    onClick={() => uninstall.mutate(installation.id)}
                  >
                    Uninstall
                  </Button>
                </span>
              </li>
              {editing === installation.id && (
                <li>
                  <InstallationGrant installation={installation} holder={holder} onDone={() => setEditing(undefined)} />
                </li>
              )}
            </Fragment>
          ))}
        </ul>
      )}
    </>
  )
}

/** The apps installed in this workspace, each acting as itself with the access it was given. */
export function InstalledAppsCard(props: { readonly workspace: WorkspaceView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Installed apps</CardTitle>
        <CardDescription>
          Each acts as itself, never as you, with the access it was given here. A change applies at once; uninstalling
          ends it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary action="list the apps installed here" pending={<Skeleton className="h-6 w-full" />}>
          <Installations workspace={props.workspace} />
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
