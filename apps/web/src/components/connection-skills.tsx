import { useId } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ServerView, SetupCatalog } from '@goblin/contracts'
import { Button, Switch } from '@goblin/ui'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryError } from '../lib/query/query-boundary.tsx'
import { setSkillsMutation } from '../mcp/queries.ts'
import { setupCatalogQuery } from '../setup/queries.ts'

type Skills = SetupCatalog['libraries'][number]['skills']

function SkillList({ skills }: { readonly skills: Skills }) {
  return (
    <ul className="skill-list">
      {skills.map((skill) => (
        <li key={skill.uri} className="skill-row">
          <span className="skill-name">{skill.name}</span>
          {skill.description !== '' && <span className="skill-description">{skill.description}</span>}
        </li>
      ))}
    </ul>
  )
}

/** Mounted only after the owner enables this library. Remote skill descriptions remain plain text. */
function SkillCatalog({ connectionId }: { readonly connectionId: string }) {
  const read = useQuery(setupCatalogQuery)
  if (read.isPending)
    return (
      <p className="server-note" role="status">
        Reading its skill library…
      </p>
    )
  if (read.error !== null)
    return <QueryError error={read.error} action="read its skills" onRetry={() => void read.refetch()} />
  const library = read.data.libraries.find((candidate) => candidate.connectionId === connectionId)
  if (library === undefined || !library.available)
    return (
      <div className="capability-empty">
        <p className="server-note">Skills are on, but this server’s library is unavailable right now.</p>
        <Button size="sm" variant="outline" pending={read.isFetching} onClick={() => void read.refetch()}>
          Try again
        </Button>
      </div>
    )
  if (library.skills.length === 0) return <p className="server-note">This server has no skills available right now.</p>
  const remaining = library.skills.slice(8)
  return (
    <>
      <p className="server-note tabular-nums">
        {library.skills.length} {library.skills.length === 1 ? 'skill' : 'skills'} available
      </p>
      <SkillList skills={library.skills.slice(0, 8)} />
      {remaining.length > 0 && (
        <details className="skill-more">
          <summary>Show {remaining.length} more skills</summary>
          <SkillList skills={remaining} />
        </details>
      )}
    </>
  )
}

/** Keep the trust control beside the skills it enables; browsing never grants a tool. */
export function ConnectionSkills({
  server,
  onMessage,
}: {
  readonly server: ServerView
  readonly onMessage: (message: string) => void
}) {
  const id = useId()
  const toggle = useMutation(setSkillsMutation)
  if (server.skillsOffered !== true && server.skillsEnabled !== true) return null
  const pending = toggle.isPending
  const enabled = pending ? toggle.variables.enabled : server.skillsEnabled === true
  return (
    <section className="server-part connection-skills" aria-label="Skills">
      <h3 className="server-part-title">Skills</h3>
      <div className="setting-row">
        <span className="grant-text">
          <span id={id} className="grant-name">
            Use its skills
          </span>
          <span className="grant-about">
            Skills are procedures your agent follows. Turn this on only for a skills library you trust. A skill never
            allows a tool by itself.
          </span>
        </span>
        <Switch
          checked={enabled}
          disabled={pending}
          aria-busy={pending}
          aria-labelledby={id}
          onCheckedChange={(next) =>
            toggle.mutate(
              { connectionId: server.connectionId, enabled: next },
              {
                onError: (error) => onMessage(messageOf(error, "change whether your agent uses this server's skills")),
              },
            )
          }
        />
      </div>
      {server.skillsEnabled === true ? (
        <SkillCatalog connectionId={server.connectionId} />
      ) : (
        <p className="server-note">Turn on Use its skills to read this server’s skill names and descriptions.</p>
      )}
    </section>
  )
}
