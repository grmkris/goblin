import * as Schema from 'effect/Schema'
import type { FileStore } from '../../files/store.ts'
import { plainJson } from '../json.ts'
import type { CallResponse } from './store.ts'

export type CodeToolCall = {
  readonly connectionId: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}
export type CodeHost = {
  readonly files: FileStore
  readonly tool: (input: CodeToolCall, operationId: string) => Promise<unknown>
}
const Path = Schema.Struct({ path: Schema.String })
const Write = Schema.Struct({ path: Schema.String, text: Schema.String.check(Schema.isMaxLength(262144)) })
const Tool = Schema.Struct({
  connectionId: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
})

/** Remote annotations never authorize retries. Only these local, known operations are safe to repeat. */
export const codeReadOnly = (name: string): boolean =>
  name === 'files.read' || name === 'files.list' || name === '$yield'

/** A host wait consumes the original run deadline too; a timed-out effect remains journaled as uncertain. */
export async function codeDeadline<T>(work: Promise<T>, expiresAt: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('cumulative script wall limit exceeded')),
          Math.max(0, expiresAt - Date.now()),
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function dispatchCodeHost(
  host: CodeHost,
  name: string,
  args: unknown,
  operationId: string,
): Promise<CallResponse> {
  let value: unknown
  switch (name) {
    case '$yield':
      return { ok: true, value: null }
    case 'files.read':
      value = (await host.files.text(Schema.decodeUnknownSync(Path)(args).path, 0, 262144)).text
      break
    case 'files.list':
      value = (await host.files.list(Schema.decodeUnknownSync(Schema.Struct({ dir: Schema.String }))(args).dir)).entries
      break
    case 'files.write': {
      const { path, text } = Schema.decodeUnknownSync(Write)(args)
      value = (
        await host.files.write(
          'agent',
          path,
          text,
          'text/plain; charset=utf-8',
          new TextEncoder().encode(text).byteLength,
        )
      ).path
      break
    }
    case 'tools.call':
      value = await host.tool(Schema.decodeUnknownSync(Tool)(args), operationId)
      break
    default:
      throw new Error('unknown durable host call')
  }
  return { ok: true, value: plainJson(value, 262144, 'host result') }
}
