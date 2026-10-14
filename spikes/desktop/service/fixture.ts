import fixture from '../fixtures/chat.json'
import type { Chat, Command, Message, ViewState } from '../shared/src/types'

function seed(): Chat[] {
  return fixture.conversations.map((chat) => ({
    ...chat,
    messages: chat.messages.map((message): Message => ({
      ...message,
      role: message.role === 'user' ? 'user' : message.role === 'tool' ? 'tool' : 'assistant',
    })),
  }))
}

export class Fixture {
  #chats = seed()
  #selected = this.#chats[0]?.id ?? 'desktop'
  #revision = 0
  #stream: ReturnType<typeof setInterval> | undefined
  #history = false
  #status = 'Local fixture · no account needed'
  #operations = new Set<string>()
  constructor(
    readonly publish: () => void,
    readonly interval = 45,
  ) {}
  get chat(): Chat {
    const chat = this.#chats.find((item) => item.id === this.#selected)
    if (!chat) throw new Error('Unknown conversation')
    return chat
  }
  view(): ViewState {
    const history: Message[] = this.#history
      ? Array.from({ length: fixture.historyCount }, (_, i) => ({
          id: `history-${i}`,
          role: i % 3 === 0 ? 'user' : 'assistant',
          text: `History ${i + 1}. ${i % 3 === 0 ? 'Keep my place while a reply arrives.' : 'A longer conversation should stay readable. Streaming belongs at the end; reading should stay where you left it.'}`,
        }))
      : []
    return {
      revision: this.#revision,
      mode: 'fixture',
      chats: this.#chats.map(({ messages: _, ...chat }) => chat),
      selected: this.#selected,
      title: this.chat.title,
      messages: [...history, ...this.chat.messages],
      streaming: this.#stream !== undefined,
      status: this.#status,
      history: this.#history,
      signedIn: false,
    }
  }
  #changed(status: string): void {
    this.#status = status
    this.#revision++
    this.publish()
  }
  dispose(): void {
    clearInterval(this.#stream)
    this.#stream = undefined
  }
  #send(input: string, operationId: string): void {
    if (this.#operations.has(operationId)) return
    if (this.#stream) throw new Error('Stop the current reply first')
    const text = input.trim()
    if (!text || text.length > 32000) throw new Error('Enter a message of up to 32,000 characters')
    this.#operations.add(operationId)
    const chat = this.chat
    chat.messages.push({ id: operationId, role: 'user', text })
    const answer: Message = { id: `${operationId}-reply`, role: 'assistant', text: '' }
    chat.messages.push(answer)
    let end = 0
    this.#stream = setInterval(() => {
      end = Math.min(fixture.reply.length, end + 9)
      answer.text = fixture.reply.slice(0, end)
      if (end === fixture.reply.length) {
        this.dispose()
        this.#changed('Fixture response complete')
      } else this.#changed('Goblin is writing…')
    }, this.interval)
    this.#changed('Message accepted · streaming locally')
  }
  command(command: Command): void {
    if (command.type === 'send') this.#send(command.text, command.operationId)
    else if (command.type === 'stop') {
      this.dispose()
      this.#changed('Reply stopped · partial text kept')
    } else if (command.type === 'select') {
      if (!this.#chats.some((item) => item.id === command.id)) throw new Error('Unknown conversation')
      this.dispose()
      this.#selected = command.id
      this.#history = false
      this.#changed('Conversation selected')
    } else if (command.type === 'new') {
      this.dispose()
      this.#selected = crypto.randomUUID()
      this.#history = false
      this.#chats.push({ id: this.#selected, title: 'New conversation', detail: 'Just now', messages: [] })
      this.#changed('A fresh conversation')
    } else if (command.type === 'history') {
      this.#history = !this.#history
      this.#changed(this.#history ? `${fixture.historyCount} synthetic messages added` : 'Short history restored')
    } else if (command.type === 'reconnect') this.#changed('Reconnected · fresh fixture snapshot')
  }
}
