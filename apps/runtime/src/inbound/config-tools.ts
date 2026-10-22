import { RoutineEdit, RoutineProposal, RoutineRevision, SourceId } from '@goblin/contracts'
import type { McpServer } from '@modelcontextprotocol/server'
import * as Schema from 'effect/Schema'
import { type Add, type Reply, reads, standard, writes } from './tools.ts'

// What a coding agent configures a workspace with on /mcp (ADR 0098): what setups are chosen from and the Sources
// (`setup`), and reading and drafting routines (`routines`). Changing a routine takes an admin, and confirming one
// stays the web's, so a client never approves its own draft.

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
          "The workspace's MCP connections: each one's id, label, endpoint and status, and whether it offers skills and events. Their granted tools are setup_catalog's. Connecting one or granting tools stays the web's.",
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
