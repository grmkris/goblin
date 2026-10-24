import { TOOL_SEARCH_TOOL_NAME } from '@earendil-works/pi-durable/tool-search'
import type { ToolNeed } from '../grants/power.ts'
import { SEPARATOR } from './native-tools.ts'

// What each of the agent's tools needs of a turn (ADR 0115): the one table the offered-tool filter
// (`setup/scope.ts` `piToolsFor`), the call-time guard and each tool's own check read (`pi/power.ts`). A tool not in it
// is never offered and never runs, so a tool added later stays off until it is given its need here. Where a tool's
// need depends on what a call asks for (a setup it brings, another Topic it acts on, an MCP connection it calls), the
// tool checks that part itself.

const READ: ToolNeed = { level: 'read' }
const WRITE: ToolNeed = { level: 'write' }
const MANAGE: ToolNeed = { level: 'manage' }
const ROUTINES: ToolNeed = { level: 'read', extra: 'routines' }

/** Calling the workspace's apps: a person's turn, or a hub's; what the apps listing in the context needs too. */
export const APP_CALL: ToolNeed = { level: 'write', people: true }

/** Each tool of the agent's by name, and what it needs. */
export const TOOL_NEEDS: Readonly<Record<string, ToolNeed>> = {
  // Reading within the boundary: what the turn's own Topic holds (from a hub, every Topic), and asking whoever wrote.
  search_chats: READ,
  zoom: READ,
  files_list: READ,
  files_read: READ,
  skill_read: READ,
  mcp_list: READ,
  ask_user: READ,
  share_back: READ,
  subagent_status: READ,
  [TOOL_SEARCH_TOOL_NAME]: READ,
  // Calling out: each call's connection must be in the turn's power too (`callRemoteTool`, the skills tools).
  mcp_call: WRITE,
  skill_activate: WRITE,
  // Writing within the boundary: its own folder, code over it, helpers.
  files_write: WRITE,
  files_delete: WRITE,
  file_link: WRITE,
  code_run: WRITE,
  subagent_spawn: WRITE,
  subagent_send: WRITE,
  subagent_stop: WRITE,
  subagent_config: WRITE,
  // Organizing: making a Topic anywhere (a setup takes `setup` too), changing one (another one only from a hub).
  topic_create: WRITE,
  topic_rename: MANAGE,
  topic_archive: MANAGE,
  topic_setup: { level: 'manage', extra: 'setup' },
  persona_create: MANAGE,
  persona_update: MANAGE,
  // Routines are the workspace's: another Topic's only from a hub.
  routine_propose: ROUTINES,
  routine_list: ROUTINES,
  routine_pause: ROUTINES,
  // Sources route anywhere in the workspace, so only from a hub; asking for a server is a setup's.
  source_propose: { level: 'read', extra: 'setup', hub: true },
  source_routes: { level: 'read', extra: 'setup', hub: true },
  source_route: { level: 'write', extra: 'setup', hub: true },
  mcp_suggest: { level: 'read', extra: 'setup' },
  mcp_request_server: { level: 'read', extra: 'setup' },
  diagnose: { level: 'read', extra: 'inspect' },
  // Apps are the workspace's: on a person's turn or from a hub, never on an installed app's turn elsewhere.
  app_docs: { level: 'read', people: true },
  app_inspect: { level: 'read', people: true },
  app_call: APP_CALL,
  app_build: { level: 'write', extra: 'setup', people: true },
  app_rollback: { level: 'write', extra: 'setup', people: true },
}

/**
 * What tool `name` needs: its entry, or for a Persona fork's native MCP tool (`<server>__<tool>`, ADR 0101) what
 * `mcp_call` needs, since `callRemoteTool` checks each of its calls as one. None for a tool the table does not know.
 */
export const needOf = (name: string): ToolNeed | undefined =>
  TOOL_NEEDS[name] ?? (name.includes(SEPARATOR) ? WRITE : undefined)

/** Whether every turn may use a tool that needs `need`, so no power is read for it: a read with nothing more. */
export const anyTurn = (need: ToolNeed): boolean =>
  need.level === 'read' && need.extra === undefined && need.hub === undefined && need.people === undefined
