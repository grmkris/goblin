import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { attempt } from '../http/errors.ts'
import { AgentInput } from '../runtime/input.ts'
import { Files } from './service.ts'
import type { FileView } from './folders.ts'

/**
 * `Files` over the owner's file store the apps engine holds (the one `code_run` uses), so the owner's routes, the
 * agent's file tools and its scripts share one store.
 */
export const FilesLive = Layer.effect(
  Files,
  AgentInput.useSync(({ agentApps: { ownerFiles: store } }) =>
    Files.of({
      list: Effect.fn('Files.list')(function* (view: FileView, dir: string) {
        return yield* attempt(() => store.list(view, dir))
      }),
      stat: Effect.fn('Files.stat')(function* (view: FileView, path: string) {
        return yield* attempt(() => store.stat(view, path))
      }),
      read: Effect.fn('Files.read')(function* (view: FileView, path: string) {
        return yield* attempt(() => store.read(view, path))
      }),
      text: Effect.fn('Files.text')(function* (view: FileView, path: string, offset: number, maxBytes: number) {
        return yield* attempt(() => store.text(view, path, offset, maxBytes))
      }),
      write: Effect.fn('Files.write')(function* (
        view: FileView,
        path: string,
        body: string | Uint8Array | ReadableStream<Uint8Array>,
        mimeType: string,
        size: number,
      ) {
        return yield* attempt(() => store.write(view, path, body, mimeType, size))
      }),
      remove: Effect.fn('Files.remove')(function* (view: FileView, path: string) {
        return yield* attempt(() => store.remove(view, path))
      }),
    }),
  ),
)
