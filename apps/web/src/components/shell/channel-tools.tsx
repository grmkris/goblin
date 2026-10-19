import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  hasApp,
  hasLibrary,
  hasSkill,
  hasTool,
  hasServer,
  type TopicView,
  type SetupCatalog,
  type ServerView,
  type Grant,
} from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { ChevronRightIcon } from 'lucide-react'
import { grantsQuery, serversQuery } from '../../mcp/queries.ts'
import { setupCatalogQuery } from '../../setup/queries.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { unavailableIn } from '../../lib/setup.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { connectionAnchor } from '../server-card.tsx'

/** Current capabilities, never a claim that a skill or connection was used in a past reply. */
export function ChannelTools({ topic, onEdit }: { readonly topic: TopicView; readonly onEdit: () => void }) {
  const catalog = useQuery({ ...setupCatalogQuery, staleTime: 0 })
  const servers = useQuery({ ...serversQuery, staleTime: 0 })
  const grants = useQuery({ ...grantsQuery, staleTime: 0 })
  const failure = catalog.error ?? servers.error ?? grants.error
  if (failure !== null)
    return (
      <div role="alert">
        <p>{messageOf(failure, 'read channel tools')}</p>
        <Button
          variant="outline"
          onClick={() => {
            catalog.refetch().catch(reportUnexpected)
            servers.refetch().catch(reportUnexpected)
            grants.refetch().catch(reportUnexpected)
          }}
        >
          Try again
        </Button>
      </div>
    )
  if (catalog.data === undefined || servers.data === undefined || grants.data === undefined)
    return <p role="status">Loading tools & skills…</p>
  const available = catalog.data
  const permissions = grants.data
  const apps = available.apps.filter(({ name }) => hasApp(topic.setup, name))
  return (
    <div className="channel-info-sections">
      <p className="channel-info-empty">
        Tools for this channel and its threads. Personas may add more. Connection permissions and Ask first still apply.
      </p>
      <Button variant="outline" size="sm" onClick={onEdit}>
        Choose tools & skills
      </Button>
      <ChannelConnections topic={topic} available={available} servers={servers.data} permissions={permissions} />
      <ChannelSkills topic={topic} available={available} />
      <section className="channel-info-section">
        <h2>Apps</h2>
        {apps.length === 0 ? (
          <p className="channel-info-empty">No apps available here yet.</p>
        ) : (
          <ul>
            {apps.map((app) => (
              <li key={app.name}>{app.title}</li>
            ))}
          </ul>
        )}
      </section>
      <section className="channel-info-section">
        <h2>Background helpers</h2>
        <p>{topic.setup.subagents ? 'Goblin can delegate work to helpers.' : 'Background helpers are off here.'}</p>
      </section>
      <ChannelUnavailable topic={topic} available={available} servers={servers.data} />
      {(topic.setup.mcpServers === 'all' || topic.setup.skills === 'all' || topic.setup.apps === 'all') && (
        <p className="channel-info-footnote">
          “All” includes what you allow now and in the future. Choose a list to keep this channel focused.
        </p>
      )}
    </div>
  )
}

/** How a connection stands in this channel, most limiting first. */
type ConnectionStatus = 'off' | 'needs_auth' | 'unavailable' | 'no_tools' | 'ready'
const STATUS_LABEL: Readonly<Record<ConnectionStatus, string>> = {
  off: 'Off in this channel',
  needs_auth: 'Needs sign-in',
  unavailable: 'Unavailable',
  no_tools: 'No tools allowed',
  ready: 'Ready',
}

function connectionStatus(server: ServerView, topic: TopicView, allowed: number): ConnectionStatus {
  if (!hasServer(topic.setup, server.connectionId)) return 'off'
  if (server.status === 'needs_auth') return 'needs_auth'
  if (server.status !== 'connected') return 'unavailable'
  return allowed === 0 ? 'no_tools' : 'ready'
}

function ConnectionDetails({
  server,
  topic,
  available,
  permissions,
}: {
  readonly server: ServerView
  readonly topic: TopicView
  readonly available: SetupCatalog
  readonly permissions: readonly Grant[]
}) {
  const allowed =
    available.servers
      .find((item) => item.connectionId === server.connectionId)
      ?.tools.filter((tool) => hasTool(topic.setup, server.connectionId, tool.name)) ?? []
  const status = connectionStatus(server, topic, allowed.length)
  return (
    <details className="channel-info-capability">
      <summary>
        <ChevronRightIcon aria-hidden />
        <span>{server.label}</span>
        <small data-ready={status === 'ready' || undefined}>{STATUS_LABEL[status]}</small>
      </summary>
      <ul>
        {allowed.map((tool) => (
          <li key={tool.name}>
            <span>{tool.title ?? tool.name}</span>
            {permissions.some(
              (grant) =>
                grant.connectionId === server.connectionId &&
                grant.capability === 'tool' &&
                grant.name === tool.name &&
                grant.askFirst,
            ) && <small>Ask first</small>}
          </li>
        ))}
      </ul>
      <Link to="/connections" hash={connectionAnchor(server.connectionId)} className="channel-info-link">
        Manage connection
      </Link>
    </details>
  )
}

function ChannelConnections({
  topic,
  available,
  servers,
  permissions,
}: {
  readonly topic: TopicView
  readonly available: SetupCatalog
  readonly servers: readonly ServerView[]
  readonly permissions: readonly Grant[]
}) {
  return (
    <section className="channel-info-section">
      <h2>Connections</h2>
      {servers.length === 0 && (
        <p className="channel-info-empty">Add a connection to give goblin tools to work with.</p>
      )}
      {servers.map((server) => (
        <ConnectionDetails
          key={server.connectionId}
          server={server}
          topic={topic}
          available={available}
          permissions={permissions}
        />
      ))}
      <Link className="channel-info-link" to="/connections">
        Add a connection
      </Link>
    </section>
  )
}

function ChannelSkills({ topic, available }: { readonly topic: TopicView; readonly available: SetupCatalog }) {
  const libraries = available.libraries.filter(({ connectionId }) => hasLibrary(topic.setup, connectionId))
  return (
    <section className="channel-info-section">
      <h2>Available skills</h2>
      {libraries.length === 0 && (
        <p className="channel-info-empty">
          No skill libraries enabled here. Enable skills on a connection to see what it offers.
        </p>
      )}
      {libraries.map((library) => {
        const skills = library.skills.filter((skill) =>
          hasSkill(topic.setup, { connectionId: library.connectionId, name: skill.name, uri: skill.uri }),
        )
        return (
          <details key={library.connectionId} className="channel-info-capability">
            <summary>
              <ChevronRightIcon aria-hidden />
              <span>{library.label}</span>
              <small>{library.available ? `${skills.length} available` : 'Library unavailable'}</small>
            </summary>
            {library.available && skills.length === 0 && (
              <p className="channel-info-empty">No skills available in this selection.</p>
            )}
            <ul>
              {skills.map((skill) => (
                <li key={skill.uri}>
                  <div>
                    <b>{skill.name}</b>
                    {skill.description && <p>{skill.description}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )
      })}
    </section>
  )
}

/**
 * What this channel's setup lists that cannot be used now, as the setup editor names it (`unavailableIn`). A connection
 * with its own row above already says how it stands there.
 */
function ChannelUnavailable({
  topic,
  available,
  servers,
}: {
  readonly topic: TopicView
  readonly available: SetupCatalog
  readonly servers: readonly ServerView[]
}) {
  const gone = unavailableIn(topic.setup, available).filter(
    ({ item }) => item.kind !== 'server' || !servers.some((server) => server.connectionId === item.connectionId),
  )
  if (gone.length === 0) return null
  return (
    <section className="channel-info-section">
      <h2>Unavailable</h2>
      {gone.map(({ label, reason }) => (
        <p key={label}>
          <span>{label}</span> <small>{reason}</small>
        </p>
      ))}
    </section>
  )
}
