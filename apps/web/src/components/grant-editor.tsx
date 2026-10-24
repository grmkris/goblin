// The one grant editor (ADR 0114): an installed app and an MCP client hold the same grant, so the install page, an
// installation's card, the consent page and Settings' MCP clients change it with the same controls. The reach is
// goblin's own: which workspaces, then in each its Topics, Personas and connections as all or a pick, then the MCP
// servers the credential may bring.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  type Extra,
  GRANT_SPEC,
  type GoblinReach,
  type GrantTerms,
  type GrantOrigin,
  type Level,
  type WorkspaceReach,
  type WorkspaceView,
  grantOriginsOf,
} from '@goblin/contracts'
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FieldGroup,
  FieldLegend,
  FieldSet,
  GrantChoice,
  GrantSummary,
  GrantTermsEditor,
  type GrantWords,
  Input,
  RadioGroup,
  ReachListChoice,
  type ReachSelection,
} from '@goblin/ui'
import { ChevronRightIcon, XIcon } from 'lucide-react'
import { Forbidden, InvalidInput } from '@goblin/contracts/api'
import { reachItemsQuery } from '../account/queries.ts'
import {
  type ReachField,
  describeReach,
  entryOf,
  entryWords,
  reachedWorkspaces,
  reachesAnything,
  withEntry,
  withWorkspaces,
} from '../lib/grant-reach.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'

/** goblin's words for each level and extra, each in one line. */
export const GRANT_WORDS: GrantWords<Level, Extra> = {
  levels: {
    read: { label: 'Read', description: 'See the Topics, chats and Personas it reaches.' },
    write: {
      label: 'Write',
      description: 'Also send messages, start Topics and threads, answer questions and stop runs.',
    },
    manage: {
      label: 'Manage',
      description: "Also make, change and archive Personas, and change a Topic's settings.",
    },
  },
  extras: {
    setup: {
      label: 'Setup',
      description:
        'Read and change what setups use: MCP servers, skills and Sources. With manage, also add servers, start their sign-in and grant their tools.',
    },
    routines: { label: 'Routines', description: 'Read and draft routines; a draft runs only once confirmed here.' },
    inspect: {
      label: 'Inspect',
      description: 'See how the runs it reaches went: model and tool calls and timings, never their words.',
    },
  },
}

/** Whose grant it is: an installation's, over its one workspace, or an MCP client's, over the person's workspaces. */
export type GrantHolder =
  | { readonly kind: 'app'; readonly workspace: WorkspaceView }
  | { readonly kind: 'client'; readonly workspaces: readonly WorkspaceView[] }

const workspacesOf = (holder: GrantHolder): readonly WorkspaceView[] =>
  holder.kind === 'app' ? [holder.workspace] : holder.workspaces

/** The grant's reach in words, as its summary line says it: an installation's without naming its workspace. */
export const reachWords =
  (holder: GrantHolder) =>
  (reach: GoblinReach): string =>
    describeReach(reach, workspacesOf(holder), holder.kind === 'app' ? holder.workspace.id : undefined)

/** What is wrong with `rows` as a grant's MCP servers, in words, before anything is sent (`grantOriginsOf`). */
const ORIGIN_PROBLEMS = {
  origin: 'Each server needs its own https address of a public host, like https://mcp.example.com, at most 8.',
  origin_tools: 'Each server needs 1 to 50 tool names, separated by commas.',
} as const

/**
 * Why saving a grant's terms failed, in words: the grant endpoints' refusals of terms that cannot be given (an
 * installation's from a member, servers the contract refuses, terms for another grant), else `messageOf`'s copy for
 * `action`.
 */
export const grantFailure = (error: unknown, action: string): string => {
  if (error instanceof Forbidden && error.reason === 'role')
    return withRef("Only the workspace's owners and admins give an app its access.", error)
  if (error instanceof InvalidInput && (error.reason === 'origin' || error.reason === 'origin_tools'))
    return withRef(ORIGIN_PROBLEMS[error.reason], error)
  if (error instanceof InvalidInput && error.reason === 'grant')
    return withRef('That access changed meanwhile. Reload the page and try again.', error)
  return messageOf(error, action)
}

/** Why `terms` cannot be saved yet, in words; empty when they can. */
export const grantProblem = (terms: GrantTerms): string => {
  if (!reachesAnything(terms.reach)) return 'Choose at least one workspace.'
  const checked = grantOriginsOf(terms.reach.origins)
  return 'problem' in checked ? ORIGIN_PROBLEMS[checked.problem] : ''
}

/** The grant in one line: "<name> can write everything · no setup, routines or inspect · until revoked". */
export function GrantLine(props: { readonly name: string; readonly terms: GrantTerms; readonly holder: GrantHolder }) {
  return (
    <GrantSummary
      clientName={props.name}
      terms={props.terms}
      spec={GRANT_SPEC}
      words={GRANT_WORDS}
      describeReach={reachWords(props.holder)}
    />
  )
}

const NOUNS: Readonly<Record<ReachField, { readonly noun: string; readonly hint: string }>> = {
  topics: { noun: 'Topics', hint: 'Including ones made later.' },
  personas: { noun: 'Personas', hint: 'Including ones made later.' },
  connections: { noun: 'connections', hint: 'Including ones added later.' },
}

/** One kind in one workspace: all of it, or a pick from what its agent lists, read only once picking. */
function KindChoice(props: {
  readonly slug: string
  readonly field: ReachField
  readonly value: ReachSelection
  readonly onChange: (value: ReachSelection) => void
  readonly disabled?: boolean | undefined
}) {
  const items = useQuery(reachItemsQuery(props.slug, props.field, props.value.kind === 'list'))
  const { noun, hint } = NOUNS[props.field]
  return (
    <ReachListChoice
      noun={noun}
      allHint={hint}
      value={props.value}
      onChange={props.onChange}
      items={items.data}
      failure={items.error === null ? undefined : messageOf(items.error, `list the ${noun} you can pick`)}
      disabled={props.disabled}
    />
  )
}

/** One workspace's Topics, Personas and connections. */
function WorkspaceFields(props: {
  readonly workspace: WorkspaceView
  readonly entry: WorkspaceReach
  readonly onChange: (entry: WorkspaceReach) => void
  readonly disabled?: boolean | undefined
}) {
  return (
    <FieldGroup>
      {(['topics', 'personas', 'connections'] as const).map((field) => (
        <KindChoice
          key={field}
          slug={props.workspace.slug}
          field={field}
          value={props.entry[field]}
          onChange={(value) => props.onChange({ ...props.entry, [field]: value })}
          disabled={props.disabled}
        />
      ))}
    </FieldGroup>
  )
}

/** A workspace among several a client reaches: what it reaches there in a line, opened to change it. */
function WorkspaceSection(props: {
  readonly workspace: WorkspaceView
  readonly entry: WorkspaceReach
  readonly onChange: (entry: WorkspaceReach) => void
  readonly disabled?: boolean | undefined
}) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{props.workspace.name}</span>
          <span className="text-sm text-muted-foreground">{entryWords(props.entry)}</span>
        </span>
        <CollapsibleTrigger render={<Button type="button" variant="ghost" disabled={props.disabled} />}>
          {open ? <XIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
          {open ? 'Hide' : 'Narrow'}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        {open ? (
          <div className="mt-3 border-l border-hairline pl-4">
            <WorkspaceFields {...props} />
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Which of the person's workspaces a client reaches: all (ones they join later included), or those picked. */
function WorkspacesChoice(props: {
  readonly reach: GoblinReach
  readonly workspaces: readonly WorkspaceView[]
  readonly onChange: (reach: GoblinReach) => void
  readonly disabled?: boolean | undefined
}) {
  const { reach, workspaces, onChange, disabled } = props
  const listed = reach.each.map((entry) => entry.workspace)
  const toggle = (id: string, on: boolean) =>
    onChange(withWorkspaces(reach, on ? [...listed, id] : listed.filter((each) => each !== id)))
  return (
    <FieldSet>
      <FieldLegend variant="label">Workspaces</FieldLegend>
      <RadioGroup
        aria-label="Workspaces"
        value={reach.workspaces}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === 'all') onChange(withWorkspaces(reach, 'all'))
          // Narrowing from all starts from the only workspace, when there is one, else from none.
          else if (next === 'list' && reach.workspaces === 'all')
            onChange(withWorkspaces(reach, workspaces.length === 1 ? workspaces.map((each) => each.id) : []))
        }}
      >
        <GrantChoice
          type="radio"
          value="all"
          checked={reach.workspaces === 'all'}
          label="All my workspaces"
          description="Including ones you join later."
          disabled={disabled}
          onChange={() => onChange(withWorkspaces(reach, 'all'))}
        />
        <GrantChoice
          type="radio"
          value="list"
          checked={reach.workspaces === 'list'}
          label="Only these"
          disabled={disabled}
          onChange={() => onChange(withWorkspaces(reach, []))}
        />
      </RadioGroup>
      {reach.workspaces === 'list' && (
        <div role="group" className="flex flex-col pl-7" aria-label="Workspaces it reaches">
          {workspaces.map((workspace) => (
            <GrantChoice
              key={workspace.id}
              type="checkbox"
              checked={listed.includes(workspace.id)}
              label={workspace.name}
              description={`/w/${workspace.slug}`}
              disabled={disabled}
              onChange={(on) => toggle(workspace.id, on)}
            />
          ))}
        </div>
      )}
    </FieldSet>
  )
}

/**
 * The reach: an installation's Topics, Personas and connections in its workspace, or a client's workspaces and each
 * one's.
 */
function ReachFields(props: {
  readonly reach: GoblinReach
  readonly holder: GrantHolder
  readonly onChange: (reach: GoblinReach) => void
  readonly disabled?: boolean | undefined
}) {
  const { reach, holder, onChange, disabled } = props
  const change = (entry: WorkspaceReach) => onChange(withEntry(reach, entry))
  if (holder.kind === 'app')
    return (
      <WorkspaceFields
        workspace={holder.workspace}
        entry={entryOf(reach, holder.workspace.id)}
        onChange={change}
        disabled={disabled}
      />
    )
  const reached = reachedWorkspaces(reach, holder.workspaces)
  const shown = holder.workspaces.filter((workspace) => reached.includes(workspace.id))
  return (
    <FieldGroup>
      <WorkspacesChoice reach={reach} workspaces={holder.workspaces} onChange={onChange} disabled={disabled} />
      {shown.length > 0 && (
        <FieldSet>
          <FieldLegend variant="label">In each workspace</FieldLegend>
          {shown.map((workspace) => (
            <WorkspaceSection
              key={workspace.id}
              workspace={workspace}
              entry={entryOf(reach, workspace.id)}
              onChange={change}
              disabled={disabled}
            />
          ))}
        </FieldSet>
      )}
    </FieldGroup>
  )
}

/** One MCP server being edited: its address and its tools as typed, comma-separated. */
type OriginRow = { readonly origin: string; readonly tools: string }

const rowsOf = (origins: readonly GrantOrigin[]): readonly OriginRow[] =>
  origins.map(({ origin, tools }) => ({ origin, tools: tools.join(', ') }))
const originsOf = (rows: readonly OriginRow[]): readonly GrantOrigin[] =>
  rows
    .filter((row) => row.origin.trim() !== '' || row.tools.trim() !== '')
    .map((row) => ({
      origin: row.origin.trim(),
      tools: row.tools
        .split(',')
        .map((tool) => tool.trim())
        .filter((tool) => tool !== ''),
    }))

/**
 * The MCP servers the credential may bring into its threads (ADRs 0091, 0103), each an https origin with exactly the
 * tools they may call there. The rows keep what is typed; the grant takes what they say.
 */
function OriginsField(props: {
  readonly origins: readonly GrantOrigin[]
  readonly onChange: (origins: readonly GrantOrigin[]) => void
  readonly disabled?: boolean | undefined
}) {
  const [rows, setRows] = useState(() => rowsOf(props.origins))
  const change = (next: readonly OriginRow[]) => {
    setRows(next)
    props.onChange(originsOf(next))
  }
  const set = (index: number, row: OriginRow) => change(rows.map((each, at) => (at === index ? row : each)))
  return (
    <FieldSet>
      <FieldLegend variant="label">Servers it may bring</FieldLegend>
      <p className="m-0 text-sm text-pretty text-muted-foreground">
        MCP servers its threads may connect to, and the tools they may call there.
      </p>
      {rows.map((row, index) => (
        // The rows have no ids of their own; their order is their identity while editing.
        <div key={index} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <Input
            aria-label="Server address"
            placeholder="https://mcp.example.com"
            value={row.origin}
            disabled={props.disabled}
            onChange={(event) => set(index, { ...row, origin: event.target.value })}
          />
          <Input
            aria-label="Tools"
            placeholder="job_submit, job_status"
            value={row.tools}
            disabled={props.disabled}
            onChange={(event) => set(index, { ...row, tools: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => change(rows.filter((_, at) => at !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={props.disabled}
          onClick={() => change([...rows, { origin: '', tools: '' }])}
        >
          Add a server
        </Button>
      </div>
    </FieldSet>
  )
}

/** An installation's or a client's grant: its level, reach, extras, lifetime and the servers it may bring. */
export function GrantEditor(props: {
  readonly terms: GrantTerms
  readonly holder: GrantHolder
  readonly onChange: (terms: GrantTerms) => void
  readonly disabled?: boolean | undefined
}) {
  const { terms, holder, onChange, disabled } = props
  return (
    <GrantTermsEditor
      terms={terms}
      spec={GRANT_SPEC}
      words={GRANT_WORDS}
      onChange={onChange}
      disabled={disabled}
      reach={
        <ReachFields
          reach={terms.reach}
          holder={holder}
          onChange={(reach) => onChange({ ...terms, reach })}
          disabled={disabled}
        />
      }
    >
      <OriginsField
        origins={terms.reach.origins}
        onChange={(origins) => onChange({ ...terms, reach: { ...terms.reach, origins } })}
        disabled={disabled}
      />
    </GrantTermsEditor>
  )
}
