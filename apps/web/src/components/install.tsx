import { useState } from 'react'
import { GRANT_SPEC, type GrantTerms, type InstallInfo, type InstallTarget } from '@goblin/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  ConsentSummary,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
} from '@goblin/ui'
import { approveInstallMutation, installInfoQuery } from '../account/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { AuthShell } from './auth-shell.tsx'
import { GRANT_WORDS, type GrantHolder, GrantEditor, grantFailure, grantProblem, reachWords } from './grant-editor.tsx'

/** `terms` aimed at `workspaceId`: an installation reaches its one workspace, each kind as it was (ADR 0118). */
const aimedAt = (terms: GrantTerms, workspaceId: string): GrantTerms => {
  const [first] = terms.reach.each
  const all = { kind: 'all' } as const
  return {
    ...terms,
    reach: {
      ...terms.reach,
      workspaces: 'list',
      each: [
        {
          workspace: workspaceId,
          topics: first?.topics ?? all,
          personas: first?.personas ?? all,
          connections: first?.connections ?? all,
        },
      ],
    },
  }
}

/** The workspace an install starts in: the first where the app is not installed yet, else the first. */
const firstTarget = (info: InstallInfo): InstallTarget | undefined =>
  info.workspaces.find((workspace) => !workspace.installed) ?? info.workspaces[0]

/** The app as it was registered (its own claim, not verified), its client id and the workspace that registered it. */
function AppIdentity(props: { readonly clientId: string; readonly info: InstallInfo | undefined }) {
  return (
    <Card size="sm">
      <CardContent>
        <div className="flex flex-col gap-2 text-sm">
          {props.info === undefined ? (
            <Skeleton className="h-5 w-40" />
          ) : (
            <p className="m-0 font-medium text-balance">{props.info.name}</p>
          )}
          {props.info?.homepage && (
            <p className="m-0 text-pretty text-muted-foreground">
              Says it is <span className="break-all">{props.info.homepage}</span>
            </p>
          )}
          {props.info && <p className="m-0 text-xs text-muted-foreground">Registered by {props.info.from}</p>}
          <p className="m-0 text-xs text-muted-foreground">
            Client ID <code className="break-all text-foreground">{props.clientId}</code>
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

/** The workspace to install it in, among those the person owns or administers, each saying whether it is there. */
function TargetPicker(props: {
  readonly targets: readonly InstallTarget[]
  readonly value: string
  readonly onChange: (workspaceId: string) => void
  readonly disabled: boolean
}) {
  return (
    <Field>
      <FieldLabel htmlFor="install-workspace">Workspace</FieldLabel>
      <NativeSelect
        id="install-workspace"
        value={props.value}
        disabled={props.disabled || props.targets.length < 2}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.targets.map((target) => (
          <NativeSelectOption key={target.id} value={target.id}>
            {target.name}
            {target.installed ? ' (installed: approving changes its access)' : ''}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  )
}

/** After an install with no return address (a script app's): where its access is kept. */
function Installed(props: { readonly name: string; readonly slug: string }) {
  return (
    <Alert>
      <AlertDescription>
        {props.name} is installed. Its access is under{' '}
        <a href={`/w/${encodeURIComponent(props.slug)}/settings#installed`}>Settings → Installed apps</a>.
      </AlertDescription>
    </Alert>
  )
}

/** The install page's state: the app, the chosen workspace and terms, and the approval, with what is wrong. */
function useInstall(clientId: string) {
  const read = useQuery(installInfoQuery(clientId))
  const approve = useMutation(approveInstallMutation)
  const info = read.data
  const [chosen, setChosen] = useState<string>()
  const [edited, setEdited] = useState<GrantTerms>()
  const target = info?.workspaces.find((each) => each.id === chosen) ?? (info && firstTarget(info))
  const terms = info && target && aimedAt(edited ?? info.consent.defaults, target.id)
  const readFailure = read.error === null ? '' : messageOf(read.error, 'look up this app')
  const approveFailure = approve.error === null ? '' : grantFailure(approve.error, 'install it')
  const problem = terms === undefined ? '' : grantProblem(terms)
  function install(): void {
    if (target === undefined || terms === undefined) return
    const search = new URLSearchParams(window.location.search)
    const state = search.get('state')
    const returnUrl = search.get('return_url')
    approve.mutate(
      {
        clientId,
        workspace: target.id,
        terms,
        ...(state === null ? {} : { state }),
        ...(returnUrl === null ? {} : { returnUrl }),
      },
      { onSuccess: (answer) => answer.redirect !== undefined && window.location.assign(answer.redirect) },
    )
  }
  return {
    info,
    target,
    terms,
    choose: setChosen,
    edit: setEdited,
    install,
    // Leaving for the app's return address: the button stays busy.
    pending: approve.isPending || approve.data?.redirect !== undefined,
    installed: approve.data !== undefined && approve.data.redirect === undefined,
    decided: approve.data !== undefined,
    failure: readFailure || approveFailure || problem,
    blocked: problem !== '',
    loading: read.error === null && info?.workspaces.length !== 0,
  }
}

/** The workspace and the grant, as the person changes them before installing. */
function InstallForm(props: {
  readonly info: InstallInfo
  readonly target: InstallTarget
  readonly terms: GrantTerms
  readonly onChoose: (workspaceId: string) => void
  readonly onEdit: (terms: GrantTerms) => void
  readonly disabled: boolean
}) {
  const holder: GrantHolder = { kind: 'key', workspace: { ...props.target, members: 1 } }
  return (
    <>
      <TargetPicker
        targets={props.info.workspaces}
        value={props.target.id}
        onChange={props.onChoose}
        disabled={props.disabled}
      />
      <ConsentSummary
        clientName={props.info.name}
        terms={props.terms}
        spec={GRANT_SPEC}
        words={GRANT_WORDS}
        describeReach={reachWords(holder)}
        disabled={props.disabled}
      >
        <GrantEditor terms={props.terms} holder={holder} onChange={props.onEdit} disabled={props.disabled} />
      </ConsentSummary>
    </>
  )
}

/**
 * Ask a workspace's owner or admin whether to install an app there, and with what grant (ADR 0118): the workspace, one
 * line of what it may do (Change opens the editor, prefilled with what the app asks for), and that it acts as the app,
 * never as them. Install sends them back to the app's return address. The app's name and address are shown as its own
 * claim.
 */
export function Install(props: { readonly clientId: string }) {
  const state = useInstall(props.clientId)
  const { info, target, terms } = state
  const name = info?.name ?? 'the app'
  return (
    <AuthShell
      size="lg"
      title={`Install “${info?.name ?? '…'}”?`}
      description={`It acts as ${name}, never as you, with the access you give it in one workspace.`}
      footer={<p>Change or uninstall it any time in Settings → Installed apps.</p>}
    >
      <div className="auth-body">
        <AppIdentity clientId={props.clientId} info={info} />
        {info?.workspaces.length === 0 && (
          <Alert>
            <AlertDescription>
              You own or administer no workspace this app can be installed in. Ask one of your workspace's owners or
              admins to install it.
            </AlertDescription>
          </Alert>
        )}
        {state.installed && target !== undefined && <Installed name={name} slug={target.slug} />}
        {!state.installed && info !== undefined && target !== undefined && terms !== undefined && (
          <InstallForm
            info={info}
            target={target}
            terms={terms}
            onChoose={state.choose}
            onEdit={state.edit}
            disabled={state.pending}
          />
        )}
        {info === undefined && state.loading && <Skeleton className="h-16" />}
        {state.failure !== '' && (
          <Alert variant="destructive">
            <AlertDescription>{state.failure}</AlertDescription>
          </Alert>
        )}
        {!state.decided && (
          <div className="flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">
            <Button
              size="lg"
              pending={state.pending}
              disabled={state.pending || terms === undefined || state.blocked}
              onClick={state.install}
            >
              Install
            </Button>
            <Button size="lg" variant="outline" disabled={state.pending} nativeButton={false} render={<Link to="/" />}>
              Cancel
            </Button>
          </div>
        )}
      </div>
    </AuthShell>
  )
}
