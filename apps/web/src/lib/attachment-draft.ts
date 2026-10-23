import type { Attachment } from '@goblin/contracts'
import { uploadAttachment } from './files.ts'
import { messageOf } from './query/app-error.ts'

export type PendingAttachment =
  | { readonly id: number; readonly name: string; readonly state: 'uploading' }
  | { readonly id: number; readonly name: string; readonly state: 'ready'; readonly file: Attachment }
  | {
      readonly id: number
      readonly name: string
      readonly state: 'failed'
      readonly reason: string
      readonly source: File
    }

/**
 * One portable draft: in-flight uploads continue when /new-thread moves its composer. Its files go to the Topic of the
 * chat its composer writes in (`topic`, ADR 0115), so that Topic's agent reads them.
 */
export class AttachmentDraft {
  #pending: readonly PendingAttachment[] = []
  #next = 0
  /** The Topic the composer this draft is in writes to; none while it is not known. */
  #topic: number | undefined
  readonly #listeners = new Set<() => void>()
  readonly #uploadFile: typeof uploadAttachment
  constructor(upload = uploadAttachment) {
    this.#uploadFile = upload
  }
  readonly snapshot = () => this.#pending
  /** Its next uploads go to Topic `topic`'s folder: the composer it is in now writes there. */
  readonly writesTo = (topic: number | undefined) => {
    this.#topic = topic
  }
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  #set(pending: readonly PendingAttachment[]): void {
    this.#pending = pending
    for (const listener of this.#listeners) listener()
  }
  readonly clear = () => this.#set([])
  readonly remove = (id: number) => this.#set(this.#pending.filter((item) => item.id !== id))
  /** Neither `retry` nor `add` rejects: an upload that fails is its item's state, with the reason and a retry. */
  readonly retry = async (id: number): Promise<void> => {
    const failed = this.#pending.find((item) => item.id === id)
    if (failed?.state !== 'failed') return
    const file = failed.source
    this.#set(this.#pending.map((item) => (item.id === id ? { id, name: file.name, state: 'uploading' } : item)))
    await this.#upload(id, file)
  }
  readonly add = async (files: readonly File[]): Promise<void> => {
    const picked = files
      .slice(0, Math.max(0, 8 - this.#pending.length))
      .map((file) => ({ file, id: (this.#next += 1) }))
    const taken = new Set(this.#pending.flatMap((item) => (item.state === 'ready' ? [item.file.name] : [])))
    this.#set([
      ...this.#pending,
      ...picked.map(({ file, id }): PendingAttachment => ({ id, name: file.name, state: 'uploading' })),
    ])
    for (const { file, id } of picked) {
      if (this.#pending.some((item) => item.id === id)) await this.#upload(id, file, taken)
    }
  }
  async #upload(id: number, file: File, taken = new Set<string>()): Promise<void> {
    try {
      const uploaded = await this.#uploadFile(file, taken, this.#topic)
      this.#set(
        this.#pending.map((item) =>
          item.id === id ? { id, name: uploaded.name, state: 'ready', file: uploaded } : item,
        ),
      )
    } catch (error) {
      this.#set(
        this.#pending.map((item) =>
          item.id === id
            ? { id, name: file.name, state: 'failed', reason: messageOf(error, `upload ${file.name}`), source: file }
            : item,
        ),
      )
    }
  }
}
