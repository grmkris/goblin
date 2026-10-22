import { Type } from '@earendil-works/pi-ai'
import { type HookApi, defineExtension, defineTool } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { describe, expect, it } from 'vitest'
import type { AppError } from '../src/http/errors.ts'
import { BACKGROUND, conversationId } from '../src/pi/context.ts'
import { PERSONA_DENIED_TOOLS, personaSelection } from '../src/pi/persona-selection.ts'
import { personaText } from '../src/pi/persona-turn.ts'
import { ROOM_TOOLS, outsideRooms, roomAllows, roomGuardExtension, roomTools } from '../src/pi/room.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'
import { CLOSED } from '../src/setup/scope.ts'
import { Setups } from '../src/setup/service.ts'
import { fake } from './fake.ts'
import { executeTool, inConversation } from './pi-tool.ts'

const tool = (name: string, ran: string[] = []) =>
  defineTool({
    name,
    description: '',
    parameters: Type.Object({}),
    execute: async () => {
      ran.push(name)
      return { output: [{ type: 'text', text: 'ran' }] }
    },
  })

/** Programs run over a `Setups` whose scope puts session 7 in room 2 and every other one outside a room. */
const roomRun = (scopes: string[] = []): RunProgram =>
  // SAFETY: the room programs read only `Setups.scope`, which this test's layer gives.
  ((program: Effect.Effect<unknown, AppError, Setups>) =>
    Effect.runPromise(
      Effect.provide(
        program,
        Layer.succeed(
          Setups,
          fake<Setups['Service']>({
            scope: (session) =>
              Effect.sync(() => {
                scopes.push(session)
                return session === '7' ? { ...CLOSED, room: 2 } : CLOSED
              }),
          }),
        ),
      ),
    )) as RunProgram

/** The guard's `beforeTool`, as Pi calls it for a call of `name` in session `session`. */
const guarded = async (run: RunProgram, name: string, session: number) => {
  const [registration] = roomGuardExtension(run).hooks ?? []
  // SAFETY: the guard's one hook is ToolTask's, and its `beforeTool` reads only the call's name and the conversation.
  const handlers = registration?.handlers as {
    readonly beforeTool: (call: { readonly name: string }, api: HookApi, context: unknown) => Promise<unknown>
  }
  return handlers.beforeTool({ name }, fake<HookApi>({ conversationId: conversationId(String(session)) }), BACKGROUND)
}

/** A bridge whose runtime did not start: every program it is given fails. */
const failing: RunProgram = async () => Promise.reject(new Error('runtime down'))

describe('a room offers only its own tools (ADR 0108)', () => {
  it('allows the gateway, skills, questions, its own chats and memory, share-back, tool_search and native tools', () => {
    for (const name of ROOM_TOOLS) expect(roomAllows(name), name).toBe(true)
    expect(roomAllows('mycut__job_submit')).toBe(true)
    for (const name of ['files_list', 'code_run', 'app_call', 'topic_create', 'routine_propose', 'diagnose'])
      expect(roomAllows(name), name).toBe(false)
  })

  it("removes every other tool of the agent's, each name once, whatever extension brought it", () => {
    const extensions = [
      defineExtension({ name: 'a', tools: [tool('mcp_call'), tool('files_list'), tool('files_read')] }),
      defineExtension({ name: 'b', tools: [tool('files_list'), tool('search_chats'), tool('later_tool')] }),
    ]
    expect(roomTools(extensions).map((each) => each.name)).toEqual(['files_list', 'files_read', 'later_tool'])
  })

  it('blocks at call time, in a room, every tool it does not offer, and reads no scope for one it does', async () => {
    const scopes: string[] = []
    const run = roomRun(scopes)
    expect(await guarded(run, 'files_list', 7)).toEqual({ block: expect.stringContaining('This chat is a room') })
    expect(await guarded(run, 'files_list', 8)).toBeUndefined()
    expect(await guarded(run, 'mcp_call', 7)).toBeUndefined()
    expect(await guarded(run, 'mycut__job_submit', 7)).toBeUndefined()
    expect(scopes).toEqual(['7', '8'])
  })

  it('fails closed when whether a chat is a room cannot be read', async () => {
    expect(await guarded(failing, 'files_list', 8)).toEqual({ block: expect.stringContaining('could not be checked') })
  })

  it("refuses a denied tool's own call in a room before it runs, and runs it anywhere else", async () => {
    const ran: string[] = []
    const extension = outsideRooms(roomRun(), defineExtension({ name: 'x', tools: [tool('files_list', ran)] }))
    const [wrapped] = extension.tools ?? []
    if (wrapped === undefined) throw new Error('the tool is gone')
    expect(await executeTool(wrapped, {}, inConversation(7))).toMatchObject({ isError: true })
    expect(await executeTool(wrapped, {}, inConversation(8))).toMatchObject({ output: [{ text: 'ran' }] })
    expect(ran).toEqual(['files_list'])
    const allowed = defineExtension({ name: 'y', tools: [tool('mcp_call')] })
    expect(outsideRooms(roomRun(), allowed)).toBe(allowed)
  })

  it("leaves out of a Persona's fork in a room every tool a room does not offer, keeping native tools", () => {
    const room = ['files_list', 'code_run', 'subagent_spawn']
    const picked = personaSelection({ tools: { remove: ['app_call'] } }, [...PERSONA_DENIED_TOOLS, ...room])
    expect(picked.tools).toEqual({
      remove: expect.arrayContaining(['app_call', 'files_list', 'code_run', 'topic_create']),
    })
    // A fork whose Persona named its tools exactly keeps its native ones and skill_activate, and loses the rest.
    const exact = personaSelection({ tools: ['mycut__job_submit', 'skill_activate', 'files_list'] }, room)
    expect(exact.tools).toEqual(['mycut__job_submit', 'skill_activate'])
    expect(personaText({ name: 'Scout', role: '', instructions: '' }, 'room')).toContain('You reach only this room')
  })
})
