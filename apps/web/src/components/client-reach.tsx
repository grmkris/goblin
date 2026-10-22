import type { ClientReach, WorkspaceView } from '@goblin/contracts'
import { Switch } from '@goblin/ui'

/** The reach a person starts from: their only workspace when they have one, else nothing chosen yet. */
export const initialReach = (workspaces: readonly WorkspaceView[]): ClientReach => {
  const [only, ...others] = workspaces
  return { all: false, workspaces: only !== undefined && others.length === 0 ? [only.id] : [] }
}

/** Whether a reach names any workspace: all of them, or at least one. */
export const reachesAny = (reach: ClientReach): boolean => reach.all || reach.workspaces.length > 0

/**
 * Which of the person's workspaces an MCP client reaches (ADR 0097): all of them, ones they join later included, or
 * each one switched on. The consent page asks it first; Settings changes it later.
 */
export function ReachChooser(props: {
  readonly workspaces: readonly WorkspaceView[]
  readonly value: ClientReach
  readonly onChange: (reach: ClientReach) => void
  readonly disabled?: boolean
}) {
  const { workspaces, value, onChange, disabled = false } = props
  const toggle = (id: string, on: boolean) =>
    onChange({
      all: false,
      workspaces: on ? [...value.workspaces, id] : value.workspaces.filter((each) => each !== id),
    })
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Workspaces it reaches">
      <label className="switch-row" data-disabled={disabled || undefined}>
        <span className="switch-name">
          <span>All my workspaces</span>
          <span className="switch-detail">Including ones you join later.</span>
        </span>
        <Switch
          checked={value.all}
          disabled={disabled}
          onCheckedChange={(on) => onChange({ all: on, workspaces: on ? [] : value.workspaces })}
        />
      </label>
      {!value.all &&
        workspaces.map((workspace) => (
          <label className="switch-row" key={workspace.id} data-disabled={disabled || undefined}>
            <span className="switch-name">
              <span>{workspace.name}</span>
              <span className="switch-detail">/w/{workspace.slug}</span>
            </span>
            <Switch
              checked={value.workspaces.includes(workspace.id)}
              disabled={disabled}
              onCheckedChange={(on) => toggle(workspace.id, on)}
            />
          </label>
        ))}
    </div>
  )
}
