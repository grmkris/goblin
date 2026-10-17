// Apps (ADR 0078): one launcher for everything that opens as an App. A search and the way to add a connection, then the
// owner's pins, recent tool-result views, connections with an App of their own and the apps built for them, in that
// order. Each source reads on its own: one that fails says so in its section and leaves the others showing.
import { type ReactNode, useState } from 'react'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { type AgentAppSummary, type AppView, type ServerView, pinKey } from '@goblin/contracts'
import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Skeleton,
} from '@goblin/ui'
import { LayoutGridIcon, PlusIcon, SparklesIcon } from 'lucide-react'
import { agentAppsQuery } from '../agent-apps/queries.ts'
import { healthQuery } from '../auth/queries.ts'
import { appNames, appOrigin } from '../lib/app-names.ts'
import { AttachmentDraft } from '../lib/attachment-draft.ts'
import { lastChannel } from '../lib/last-channel.ts'
import { type ConnectedApp, cameFrom, connectedApps, matches, pinConnection, recentViews } from '../lib/launcher.ts'
import { useNavigation } from '../lib/navigation.ts'
import { type ShownPin, targetOf } from '../lib/pins.ts'
import { QueryError } from '../lib/query/query-boundary.tsx'
import { useApps, useConversations, useTopics, useWorkspaceRead } from '../lib/workspace/hooks.ts'
import { useConnectionLabels } from '../mcp/hooks.ts'
import { serversQuery } from '../mcp/queries.ts'
import { type Pins, usePins } from '../sidebar/hooks.ts'
import { BuiltCard, ConnectedCard, PinnedCard, RecentCard } from './apps/launcher-cards.tsx'
import { PageSection } from './page-section.tsx'

/** One source's read: its answer once there, its failure (beside an older answer too), and a retry. */
type Read<T> = { readonly data: T | undefined; readonly error: unknown; readonly retry: () => void }

function readOf<T>(query: UseQueryResult<T>): Read<T> {
  return { data: query.data, error: query.error, retry: () => void query.refetch() }
}

/** Ask goblin to build an app: a new thread in the last channel with the request written, and nothing sent. */
function BuildButton({ variant }: { readonly variant: 'default' | 'outline' }) {
  const navigation = useNavigation()
  const ask = () =>
    navigation.newThreadWith(
      { text: 'Make me an app that ', selections: [], attachments: new AttachmentDraft() },
      lastChannel(),
    )
  return (
    <Button variant={variant} onClick={ask}>
      <SparklesIcon data-icon="inline-start" aria-hidden />
      Ask goblin to build an app
    </Button>
  )
}

/** The way to more Apps: a service that has one of its own, on Connections. */
const AddConnection = ({ variant }: { readonly variant: 'default' | 'outline' }) => (
  <Button variant={variant} nativeButton={false} render={<Link to="/connections" />}>
    <PlusIcon data-icon="inline-start" aria-hidden />
    Add a connection
  </Button>
)

/** Search by name or connection, and Add a connection. */
function LauncherBar({ search, onSearch }: { readonly search: string; readonly onSearch: (search: string) => void }) {
  return (
    <div className="launcher-bar">
      <div className="launcher-search" role="search">
        <Input
          type="search"
          value={search}
          placeholder="Search apps"
          aria-label="Search apps by name or connection"
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
      <AddConnection variant="outline" />
    </div>
  )
}

/** No App of any kind yet: the two ways to get one. */
function NoApps({ build }: { readonly build: boolean }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <LayoutGridIcon />
        </EmptyMedia>
        <EmptyTitle>No apps yet</EmptyTitle>
        <EmptyDescription>
          {build
            ? 'Add a connection to a service that has an app of its own, or ask goblin to build one for you.'
            : 'Add a connection to a service that has an app of its own. Its app opens from here.'}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <div className="launcher-empty-actions">
          <AddConnection variant={build ? 'outline' : 'default'} />
          {build && <BuildButton variant="default" />}
        </div>
      </EmptyContent>
    </Empty>
  )
}

/** A section's cards while its source is read, in their eventual shape. */
const Placeholders = ({ tall = false }: { readonly tall?: boolean }) => (
  <ul className="launcher-grid" aria-busy="true">
    {[0, 1].map((each) => (
      <li key={each}>
        <Skeleton className={tall ? 'h-28 w-full' : 'h-14 w-full'} />
      </li>
    ))}
  </ul>
)

/** A section of Apps: its heading, its source's failure with a retry, then its cards or their placeholders. */
function Shelf({
  id,
  title,
  failure,
  loading = false,
  tall = false,
  children,
}: {
  readonly id: string
  readonly title: string
  readonly failure?: { readonly error: unknown; readonly action: string; readonly retry: () => void }
  readonly loading?: boolean
  readonly tall?: boolean
  readonly children?: ReactNode
}) {
  return (
    <PageSection id={id} title={title}>
      {failure !== undefined && failure.error !== null && (
        <QueryError error={failure.error} action={failure.action} onRetry={failure.retry} />
      )}
      {loading ? <Placeholders tall={tall} /> : children}
    </PageSection>
  )
}

const Grid = ({ children }: { readonly children: ReactNode }) => <ul className="launcher-grid">{children}</ul>

/** What each section shows for the search, and what decides whether a section or an empty state shows at all. */
type Found = {
  readonly read: boolean
  readonly pinned: readonly ShownPin[]
  readonly recent: readonly AppView[]
  readonly names: ReadonlyMap<string, string>
  readonly servers: Read<readonly ServerView[]>
  readonly connected: readonly ConnectedApp[] | undefined
  readonly built: readonly AgentAppSummary[] | undefined
  /** No App of any kind, with every source read. */
  readonly nothing: boolean
}

/** Every source, composed and searched. `built` is absent where the deployment has no built apps (ADR 0064). */
function useFound(search: string, built: Read<readonly AgentAppSummary[]> | undefined, pins: Pins): Found {
  const apps = useApps()
  const read = useWorkspaceRead()
  const servers = readOf(useQuery(serversQuery))
  const labelOf = useConnectionLabels()
  const names = appNames(apps, labelOf)
  const recent = recentViews(apps, pins.isPinned)
  const connected = servers.data === undefined ? undefined : connectedApps(servers.data)
  const labelFor = (connectionId: string | undefined) =>
    connectionId === undefined ? undefined : labelOf(connectionId)
  return {
    read,
    pinned: pins.shown.filter((pin) => matches(search, pin.title, labelFor(pinConnection(pin)))),
    recent: recent.filter((app) => matches(search, names.get(app.id) ?? app.title, labelOf(appOrigin(app)))),
    names,
    servers,
    connected: connected?.filter((each) => matches(search, each.title, each.label)),
    built: built?.data?.filter((app) => matches(search, app.title)),
    nothing:
      read &&
      pins.shown.length === 0 &&
      recent.length === 0 &&
      connected?.length === 0 &&
      (built === undefined || built.data?.length === 0),
  }
}

/** Where a pin or a recent view came from: its view's conversation, or a server pin's label where it differs. */
function useOrigins() {
  const views = useConversations()
  const topics = useTopics()
  const labelOf = useConnectionLabels()
  return {
    from: (conversation: string) => cameFrom(conversation, views, topics),
    ofPin: (pin: ShownPin): string | undefined => {
      if (pin.kind === 'view') return pin.app === undefined ? undefined : cameFrom(pin.app.conversation, views, topics)
      const label = labelOf(pin.connectionId)
      return label.toLocaleLowerCase() === pin.title.toLocaleLowerCase() ? undefined : label
    },
  }
}

/** Built for you: every built app, its empty state with the build action, or its failure. */
function BuiltShelf({
  built,
  found,
  searching,
}: {
  readonly built: Read<readonly AgentAppSummary[]>
  readonly found: readonly AgentAppSummary[] | undefined
  readonly searching: boolean
}) {
  const views = useApps()
  const failure = { error: built.error, action: 'load the apps built for you', retry: built.retry }
  if (built.data === undefined)
    return <Shelf id="built" title="Built for you" failure={failure} loading={built.error === null} tall />
  if (found !== undefined && found.length > 0)
    return (
      <Shelf id="built" title="Built for you" failure={failure}>
        <Grid>
          {found.map((app) => (
            <BuiltCard key={app.name} app={app} view={views.find((view) => view.id === app.app)} />
          ))}
        </Grid>
      </Shelf>
    )
  if (built.data.length > 0 || searching) return null
  return (
    <Shelf id="built" title="Built for you" failure={failure}>
      <p className="launcher-note">
        Describe an app in a conversation and goblin builds it for you: a tracker, a checklist, a small dashboard.
      </p>
      <div className="launcher-empty-actions">
        <BuildButton variant="outline" />
      </div>
    </Shelf>
  )
}

/** Pinned while the feed is read, then the owner's pins that match, in their order. */
function PinnedShelf({ found, pins }: { readonly found: Found; readonly pins: Pins }) {
  const origins = useOrigins()
  if (!found.read) return <Shelf id="pinned" title="Pinned" loading />
  if (found.pinned.length === 0) return null
  return (
    <Shelf id="pinned" title="Pinned">
      <Grid>
        {found.pinned.map((pin) => (
          <PinnedCard key={pinKey(targetOf(pin))} pin={pin} pins={pins} context={origins.ofPin(pin)} />
        ))}
      </Grid>
    </Shelf>
  )
}

/** Recent while the feed is read, then the recent views that match, newest first. */
function RecentShelf({ found }: { readonly found: Found }) {
  const origins = useOrigins()
  if (!found.read) return <Shelf id="recent" title="Recent" loading />
  if (found.recent.length === 0) return null
  return (
    <Shelf id="recent" title="Recent">
      <Grid>
        {found.recent.map((app) => (
          <RecentCard
            key={app.id}
            app={app}
            name={found.names.get(app.id) ?? app.title}
            from={origins.from(app.conversation)}
          />
        ))}
      </Grid>
    </Shelf>
  )
}

/** Connected while the servers are read, then the connections with an App that match, or why they could not be read. */
function ConnectedShelf({ found }: { readonly found: Found }) {
  const { servers, connected } = found
  const failure = { error: servers.error, action: 'list your connections', retry: servers.retry }
  if (connected === undefined)
    return <Shelf id="connected" title="Connected" failure={failure} loading={servers.error === null} />
  if (connected.length === 0 && servers.error === null) return null
  return (
    <Shelf id="connected" title="Connected" failure={failure}>
      {connected.length > 0 && (
        <Grid>
          {connected.map((entry) => (
            <ConnectedCard key={entry.connectionId} entry={entry} />
          ))}
        </Grid>
      )}
    </Shelf>
  )
}

/** Whether a search found nothing in any section, with every source read: it says so once, above them. */
function nothingFound(found: Found, built: Read<readonly AgentAppSummary[]> | undefined): boolean {
  const count = found.pinned.length + found.recent.length + (found.connected?.length ?? 0) + (found.built?.length ?? 0)
  const reading =
    !found.read ||
    (found.servers.data === undefined && found.servers.error === null) ||
    (built !== undefined && built.data === undefined && built.error === null)
  return count === 0 && !reading
}

/** The four sections, or the empty state when there is no App at all. */
function Launcher({
  search,
  built,
}: {
  readonly search: string
  readonly built: Read<readonly AgentAppSummary[]> | undefined
}) {
  const pins = usePins()
  const found = useFound(search, built, pins)
  const searching = search.trim() !== ''
  if (found.nothing) return <NoApps build={built !== undefined} />
  return (
    <>
      {searching && nothingFound(found, built) && (
        <p className="launcher-note" role="status">
          No apps match “{search.trim()}”.
        </p>
      )}
      <PinnedShelf found={found} pins={pins} />
      <RecentShelf found={found} />
      <ConnectedShelf found={found} />
      {built !== undefined && <BuiltShelf built={built} found={found.built} searching={searching} />}
    </>
  )
}

/** The launcher where built apps are on: their read is this section's, and Built for you shows. */
function WithBuilt({ search }: { readonly search: string }) {
  return <Launcher search={search} built={readOf(useQuery(agentAppsQuery))} />
}

/**
 * Apps (ADR 0078): Pinned, Recent, Connected and Built for you, searched together. A deployment without built apps
 * (ADR 0064) still has Apps for the other three; until /health says so, Built for you is offered.
 */
export function AppsPage() {
  const [search, setSearch] = useState('')
  const builtOn = useQuery(healthQuery).data?.features?.agentApps !== false
  return (
    <div className="launcher">
      <LauncherBar search={search} onSearch={setSearch} />
      {builtOn ? <WithBuilt search={search} /> : <Launcher search={search} built={undefined} />}
    </div>
  )
}
