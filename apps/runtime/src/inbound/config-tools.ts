import {
  ConnectionLabel,
  GrantBatchChange,
  GrantChange,
  RoutineEdit,
  RoutineProposal,
  RoutineRevision,
  SkillsChange,
  SourceId,
} from '@goblin/contracts'
import type { McpServer } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import { type Add, type Reply, reads, standard, writes } from './tools.ts'

// What a coding agent configures a workspace with on /mcp (ADR 0098): what setups are chosen from, the Sources and the
// connections themselves (`setup`, ADR 0117: adding, signing in, tool grants and the skills switch with `manage`), and
// reading and drafting routines (`routines`). Changing a routine takes an admin, and confirming one stays the web's, so
// a client never approves its own draft; so do finishing a sign-in, the ask-first switches and App grants.

const Routine = Schema.String.check(Schema.isPattern(/^rt_[\w-]{1,100}$/u)).annotate({
  description: "A routine's id (`rt_…`), as routine_list names it.",
})
const Source = SourceId.annotate({ description: "A Source's id (`src_…`), as source_list names it." })

/** `setup_catalog`, `server_list`, `source_list` and `source_routes`: what a Topic's or Persona's setup names. */
export const setupTools = (server: McpServer, add: Add, reply: Reply) => {
  add('setup_catalog', () =>
    server.registerTool(
      'setup_catalog',
      {
        title: 'What setups are chosen from',
        description:
          "The workspace's MCP servers with their granted tools, the skill servers turned on with their skills, and its apps: the connection ids and tool names a Topic's or a Persona's setup may name.",
        inputSchema: standard(Schema.Struct({})),
        annotations: reads,
      },
      () => reply((api) => api.setup.catalog()),
    ),
  )
  add('server_list', () =>
    server.registerTool(
      'server_list',
      {
        title: 'MCP servers',
        description:
          "The workspace's MCP connections within reach: each one's id, label, endpoint and status, and whether it offers skills and events. Their granted tools are setup_catalog's and tool_grants_list's.",
        inputSchema: standard(Schema.Struct({})),
        annotations: reads,
      },
      () => reply((api) => api.mcp.servers()),
    ),
  )
  add('source_list', () =>
    server.registerTool(
      'source_list',
      {
        title: 'Sources',
        description:
          "The workspace's Sources: the connections whose messages come in as turns, each with its setup, state and revision. Confirming one stays the web's.",
        inputSchema: standard(Schema.Struct({})),
        annotations: reads,
      },
      () => reply((api) => api.sources.list()),
    ),
  )
  add('source_routes', () =>
    server.registerTool(
      'source_routes',
      {
        title: "A Source's routes",
        description: "Where each of a Source's conversations goes: a Topic, a Persona, notes only, nowhere or held.",
        inputSchema: standard(Schema.Struct({ id: Source })),
        annotations: reads,
      },
      ({ id }) => reply((api) => api.sources.routes({ params: { id } })),
    ),
  )
}

const Connection = Schema.String.check(Schema.isPattern(/^[\w-]{1,64}$/u)).annotate({
  description: "A connection's id, as server_list names it.",
})
const Scope = Schema.String.check(Schema.isPattern(/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/u))

/**
 * `server_add`, `server_rename`, `server_connect`, `server_disconnect` and `server_remove`: a workspace's connections
 * themselves (ADR 0117).
 */
export const serverTools = (server: McpServer, add: Add, reply: Reply) => {
  add('server_add', () =>
    server.registerTool(
      'server_add',
      {
        title: 'Add an MCP server',
        description:
          'Add a remote MCP server to the workspace by its address, with an optional label. It starts disconnected and grants nothing: sign in with server_connect, then grant its tools. A connection this credential adds is within its reach.',
        inputSchema: standard(
          Schema.Struct({
            endpoint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).annotate({
              description: "The server's MCP address (https).",
            }),
            label: Schema.optional(ConnectionLabel),
          }),
        ),
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      (payload) => reply((api) => api.mcp.addServer({ payload })),
    ),
  )
  add('server_rename', () =>
    server.registerTool(
      'server_rename',
      {
        title: 'Rename a connection',
        description: 'A new label for a connection within reach; another connection must not have it.',
        inputSchema: standard(Schema.Struct({ id: Connection, label: ConnectionLabel })),
        annotations: writes,
      },
      ({ id, label }) => reply((api) => api.mcp.renameConnection({ params: { id }, payload: { label } })),
    ),
  )
  add('server_connect', () =>
    server.registerTool(
      'server_connect',
      {
        title: 'Start signing in to a server',
        description:
          "Start a connection's sign-in: answers authorizationUrl when the server wants one, for the person to open in a browser signed in to goblin as an admin of this workspace, where the sign-in finishes; none when it needs none. `scope` asks for those scopes only, else everything it offers.",
        inputSchema: standard(
          Schema.Struct({
            id: Connection,
            scope: Schema.optional(Schema.Array(Scope).check(Schema.isMinLength(1), Schema.isMaxLength(64))),
          }),
        ),
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      ({ id, scope }) =>
        reply((api) => api.mcp.connect({ params: { id }, payload: scope === undefined ? {} : { scope } })),
    ),
  )
  add('server_disconnect', () =>
    server.registerTool(
      'server_disconnect',
      {
        title: 'Disconnect a server',
        description:
          "Forget a connection's sign-in and close it, its event subscriptions first. Its grants stay, so signing in again keeps them.",
        inputSchema: standard(Schema.Struct({ id: Connection })),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      ({ id }) => reply((api) => api.mcp.disconnect({ params: { id } })),
    ),
  )
  add('server_remove', () =>
    server.registerTool(
      'server_remove',
      {
        title: 'Remove a server',
        description:
          'Remove a server the workspace added, with its sign-in, grants and pending sign-ins. A server the deployment configures stays.',
        inputSchema: standard(Schema.Struct({ id: Connection })),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      ({ id }) => reply((api) => api.mcp.removeServer({ params: { id } })),
    ),
  )
}

/** `tool_grants_list`, `tool_grant_set`, `tool_grants_set` and `server_skills_set`: what a connection lends (ADR 0117). */
export const grantTools = (server: McpServer, add: Add, reply: Reply) => {
  add('tool_grants_list', () =>
    server.registerTool(
      'tool_grants_list',
      {
        title: 'Tool grants',
        description:
          "The tools, resources and Apps the workspace's agent may use on each connection within reach, and which tools ask first.",
        inputSchema: standard(Schema.Struct({})),
        annotations: reads,
      },
      () => reply((api) => api.mcp.grants()),
    ),
  )
  add('tool_grant_set', () =>
    server.registerTool(
      'tool_grant_set',
      {
        title: 'Grant or revoke a tool',
        description: "Let the workspace's agent use one discovered tool of a connection within reach, or stop.",
        inputSchema: standard(GrantChange),
        annotations: writes,
      },
      (payload) => reply((api) => api.mcp.setToolGrant({ payload })),
    ),
  )
  add('tool_grants_set', () =>
    server.registerTool(
      'tool_grants_set',
      {
        title: 'Grant or revoke tools',
        description:
          "Let the workspace's agent use the named discovered tools of a connection within reach, or stop, in one write; `missing` names those it no longer offers.",
        inputSchema: standard(GrantBatchChange),
        annotations: writes,
      },
      (payload) => reply((api) => api.mcp.setToolGrants({ payload })),
    ),
  )
  add('server_skills_set', () =>
    server.registerTool(
      'server_skills_set',
      {
        title: "Turn a server's skills on or off",
        description:
          "Whether the workspace's agent uses the skills a connection within reach serves (ADR 0008): their steps are followed, and they grant nothing.",
        inputSchema: standard(SkillsChange),
        annotations: writes,
      },
      (payload) => reply((api) => api.mcp.setSkills({ payload })),
    ),
  )
}

/** `routine_list`, `routine_runs`, `routine_propose`, `routine_edit`, `routine_archive` and `routine_pause`. */
export const routineTools = (server: McpServer, add: Add, reply: Reply) => {
  add('routine_list', () =>
    server.registerTool(
      'routine_list',
      {
        title: 'Routines',
        description:
          "The workspace's routines but the archived ones: each one's trigger, hand-off, state and revision.",
        inputSchema: standard(Schema.Struct({})),
        annotations: reads,
      },
      () => reply((api) => api.routines.list()),
    ),
  )
  add('routine_runs', () =>
    server.registerTool(
      'routine_runs',
      {
        title: "A routine's runs",
        description: "A routine's newest runs and how each ended.",
        inputSchema: standard(Schema.Struct({ id: Routine })),
        annotations: reads,
      },
      ({ id }) => reply((api) => api.routines.runs({ params: { id } })),
    ),
  )
  add('routine_propose', () =>
    server.registerTool(
      'routine_propose',
      {
        title: 'Draft a routine',
        description:
          'A new routine as a draft: it runs only once an admin confirms it in the web app (Work → Routines). Needs an admin.',
        inputSchema: standard(RoutineProposal),
        annotations: writes,
      },
      (payload) => reply((api) => api.routines.propose({ payload })),
    ),
  )
  add('routine_edit', () =>
    server.registerTool(
      'routine_edit',
      {
        title: 'Change a routine',
        description:
          'A new revision of a routine, back in draft until an admin confirms it again; `revision` must be its current one. Needs an admin.',
        inputSchema: standard(Schema.Struct({ id: Routine, change: RoutineEdit })),
        annotations: writes,
      },
      ({ id, change }) => reply((api) => api.routines.edit({ params: { id }, payload: change })),
    ),
  )
  add('routine_archive', () =>
    server.registerTool(
      'routine_archive',
      {
        title: 'Archive a routine',
        description: 'Archive a routine at its current revision; its live runs stop. Needs an admin.',
        inputSchema: standard(Schema.Struct({ id: Routine, at: RoutineRevision })),
        annotations: writes,
      },
      ({ id, at }) => reply((api) => api.routines.archive({ params: { id }, payload: at })),
    ),
  )
  add('routine_pause', () =>
    server.registerTool(
      'routine_pause',
      {
        title: 'Pause a routine',
        description: 'Pause a routine at its current revision; confirming it again resumes it. Needs an admin.',
        inputSchema: standard(Schema.Struct({ id: Routine, at: RoutineRevision })),
        annotations: writes,
      },
      ({ id, at }) => reply((api) => api.routines.pause({ params: { id }, payload: at })),
    ),
  )
}
