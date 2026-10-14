import { PRIMARY_CHAT } from '@goblin/contracts'
import { GoblinApi } from '../../mobile/src/api'
import { MobileConversation } from '../../mobile/src/conversation'
import type { SessionStore } from '../../mobile/src/session'
import type { Command, Message, ViewState } from '../shared/src/types'

/** Memory-only owner sessions belong to the companion process, never the renderer. */
class MemorySession implements SessionStore {
  #cookie: string | null = null
  async read() {
    return this.#cookie
  }
  async write(value: string) {
    this.#cookie = value
  }
  async clear() {
    this.#cookie = null
  }
}
export class Live {
  #api: GoblinApi
  #follow: MobileConversation
  #state: ViewState = {
    revision: 0,
    mode: 'live',
    chats: [{ id: PRIMARY_CHAT, title: 'Live Goblin', detail: 'Configured dev instance' }],
    selected: PRIMARY_CHAT,
    title: 'Live Goblin',
    messages: [],
    streaming: false,
    status: 'Sign in to the configured Goblin dev instance',
    history: false,
    signedIn: false,
  }
  #pending: { text: string; operationId: string } | undefined
  constructor(
    readonly origin: string,
    readonly publish: () => void,
    fetcher = fetch,
  ) {
    this.#api = new GoblinApi({ origin, native: true, sessions: new MemorySession(), fetch: fetcher })
    this.#follow = new MobileConversation(this.#api, PRIMARY_CHAT, (value) => {
      const p = value.projection
      const messages: Message[] =
        p?.messages.flatMap((m): Message[] => {
          if (m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
            return [{ id: m.id, role: m.role, text: m.text, ...(m.role === 'tool' ? { label: m.toolName } : {}) }]
          return []
        }) ?? []
      if (p?.partial) messages.push({ id: 'live-partial', role: 'assistant', text: p.partial })
      this.#set({
        messages,
        streaming: p?.running ?? false,
        status: value.status,
        ...(value.signedOut ? { signedIn: false } : {}),
      })
    })
  }
  view(): ViewState {
    return this.#state
  }
  #set(patch: Partial<ViewState>) {
    this.#state = { ...this.#state, ...patch, revision: this.#state.revision + 1 }
    this.publish()
  }
  dispose() {
    this.#follow.pause()
  }
  async command(command: Command): Promise<void> {
    if (command.type === 'code') {
      await this.#api.sendCode(command.email, command.invite)
      this.#set({ status: 'Code requested. Check your email.' })
    } else if (command.type === 'verify') {
      await this.#api.verifyCode(command.email, command.otp, command.invite)
      this.#set({ signedIn: true, status: 'Signed in · session kept only until this service exits' })
      this.#follow.reconnect()
    } else if (command.type === 'signout') {
      this.dispose()
      try {
        await this.#api.signOut()
      } finally {
        this.#pending = undefined
        this.#set({
          signedIn: false,
          messages: [],
          streaming: false,
          pendingOperation: undefined,
          status: 'Signed out',
        })
      }
    } else {
      if (!this.#state.signedIn) throw new Error('Sign in first')
      if (command.type === 'send') {
        if (this.#pending && (this.#pending.text !== command.text || this.#pending.operationId !== command.operationId))
          throw new Error('Retry the uncertain message before sending a different one')
        this.#pending = { text: command.text, operationId: command.operationId }
        this.#set({ pendingOperation: command.operationId, status: 'Submitting…' })
        await this.#api.submit(PRIMARY_CHAT, { input: command.text, operationId: command.operationId })
        this.#pending = undefined
        this.#set({ pendingOperation: undefined, status: 'Accepted · waiting for Goblin' })
      } else if (command.type === 'stop') await this.#api.stop(PRIMARY_CHAT)
      else if (command.type === 'reconnect') this.#follow.reconnect()
      else throw new Error('This live MVP supports the primary conversation only')
    }
  }
}
