import './style.css'
import { readSse } from '../../../mobile/src/sse'
import { hostName, type Command, type Message, type ViewState } from './types'

const host = hostName(new URLSearchParams(location.search).get('host'))
const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? ''
history.replaceState(null, '', location.pathname + location.search)
const hostLabels = { browser: 'Browser', gpui: 'GPUI Kit', tauri: 'Tauri', electrobun: 'Electrobun' }
function required<E extends Element>(selector: string, ctor: { new (...args: never[]): E }): E {
  const value = document.querySelector(selector)
  if (!(value instanceof ctor)) throw new Error(`Missing ${selector}`)
  return value
}
const app = required('#app', HTMLDivElement)
app.innerHTML = `<main class="shell">
<aside class="sidebar"><div class="brand"><span class="brand-mark">g.</span>goblin <small>desktop study</small></div>
<div class="section-label">Your conversations <button id="new" aria-label="New conversation">+</button></div>
<nav id="chats" aria-label="Conversations"></nav>
<div class="sidebar-bottom"><span class="online-dot"></span> A place for your agent.<div class="edition">01 — ${hostLabels[host]}</div></div></aside>
<section class="workspace"><header><div><div class="kicker">Personal agent / desktop</div><h1 id="title">A home for your agent</h1></div><span class="host-badge" data-testid="host-badge">${hostLabels[host]}</span></header>
<div class="toolbar"><label>Mode <select id="mode"><option value="fixture">Local fixture</option><option value="live">Live dev</option></select></label><button id="history">Stress history</button><button id="reconnect">Reconnect</button><button id="signout" hidden>Sign out</button><span id="count"></span></div>
<form id="auth" hidden><p>Sign in to the configured Goblin dev instance. This sends a real email code. Your session stays in memory until the companion exits.</p><label>Email<input id="email" type="email" autocomplete="email" required></label><label>Invite, if needed<input id="invite" autocomplete="off"></label><label>Code<input id="otp" inputmode="numeric" autocomplete="one-time-code"></label><div><button type="button" id="code">Send code</button><button type="submit">Sign in</button></div></form>
<div id="transcript" class="transcript" aria-label="Conversation" tabindex="0"></div>
<button id="latest" hidden>↓ Latest message</button>
<div class="composer-wrap"><div id="status" role="status">Connecting to the local companion…</div>
<form id="composer"><textarea id="input" aria-label="Message Goblin" placeholder="What are we working on?" rows="2" maxlength="20000"></textarea><footer><span>Enter to send · Shift + Enter for a new line</span><div><button type="button" id="stop" hidden>Stop reply</button><button type="submit" id="send" disabled>Send ↗</button></div></footer></form></div>
</section></main>`
const transcript = required('#transcript', HTMLDivElement)
const input = required('#input', HTMLTextAreaElement)
const sendButton = required('#send', HTMLButtonElement)
const status = required('#status', HTMLDivElement)
const latest = required('#latest', HTMLButtonElement)
let state: ViewState | undefined
let busy = false
let pending: { text: string; operationId: string } | undefined
let previousChat = ''
let previousNav = ''
const rows = new Map<string, { element: HTMLElement; body: HTMLElement; text: string }>()
const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
// A deliberately small Markdown subset; raw HTML, links and remote images are never activated.
const markdown = (value: string) =>
  escape(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replaceAll('\n', '<br>')
const nearBottom = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 64
function controls() {
  sendButton.disabled =
    busy || !input.value.trim() || Boolean(state?.streaming) || (state?.mode === 'live' && !state.signedIn)
  sendButton.textContent = pending ? 'Retry same message ↗' : 'Send ↗'
  input.readOnly = pending !== undefined
  required('#stop', HTMLButtonElement).hidden = !state?.streaming
}
function row(message: Message): HTMLElement {
  let entry = rows.get(message.id)
  if (!entry) {
    const element = document.createElement('article')
    element.className = `message ${message.role}`
    element.dataset.id = message.id
    const label = document.createElement('div')
    label.className = 'message-meta'
    label.textContent =
      message.role === 'user' ? 'You' : message.role === 'tool' ? (message.label ?? 'Tool result') : 'Goblin'
    const body = document.createElement('div')
    body.className = 'message-body'
    element.append(label, body)
    entry = { element, body, text: '' }
    rows.set(message.id, entry)
  }
  if (entry.text !== message.text) {
    entry.body.innerHTML = markdown(message.text)
    entry.text = message.text
  }
  return entry.element
}
function render(next: ViewState) {
  state = next
  const switched = previousChat !== `${next.mode}/${next.selected}`
  const bottom = nearBottom() || switched
  if (switched) {
    rows.clear()
    transcript.replaceChildren()
    previousChat = `${next.mode}/${next.selected}`
  }
  const currentIds = new Set(next.messages.map((m) => m.id))
  for (const [id, item] of rows)
    if (!currentIds.has(id)) {
      item.element.remove()
      rows.delete(id)
    }
  // Stable nodes preserve selection and scroll anchors while only the growing reply changes.
  next.messages.forEach((m, index) => {
    const element = row(m)
    if (transcript.children[index] !== element) transcript.insertBefore(element, transcript.children[index] ?? null)
  })
  if (bottom) transcript.scrollTop = transcript.scrollHeight
  latest.hidden = nearBottom()
  required('#title', HTMLHeadingElement).textContent = next.title
  status.textContent = next.status
  required('#count', HTMLSpanElement).textContent = `${next.messages.length} messages`
  const nav = JSON.stringify([next.chats, next.selected])
  if (nav !== previousNav) {
    previousNav = nav
    const list = required('#chats', HTMLElement)
    list.replaceChildren()
    for (const chat of next.chats) {
      const button = document.createElement('button')
      button.className = chat.id === next.selected ? 'selected' : ''
      button.setAttribute('aria-current', String(chat.id === next.selected))
      const title = document.createElement('span')
      title.textContent = chat.title
      const detail = document.createElement('small')
      detail.textContent = chat.detail
      button.append(title, detail)
      button.onclick = () => void command({ type: 'select', id: chat.id })
      list.append(button)
    }
  }
  required('#mode', HTMLSelectElement).value = next.mode
  required('#auth', HTMLFormElement).hidden = next.mode !== 'live' || next.signedIn
  required('#signout', HTMLButtonElement).hidden = !next.signedIn || next.mode !== 'live'
  required('#history', HTMLButtonElement).hidden = next.mode !== 'fixture'
  required('#new', HTMLButtonElement).disabled = next.mode !== 'fixture'
  required('#history', HTMLButtonElement).textContent = next.history ? 'Short history' : 'Stress history'
  controls()
}
const headers = { authorization: `Bearer ${token}`, 'x-goblin-shell': host }
async function command(value: Command): Promise<boolean> {
  if (busy) return false
  busy = true
  controls()
  try {
    const response = await fetch('/bridge/command', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
    const data = await response.json()
    if (!response.ok)
      throw new Error(typeof data.error === 'string' ? data.error : `Command refused (${response.status})`)
    render(data)
    return true
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Connection failed'
    return false
  } finally {
    busy = false
    controls()
  }
}
input.oninput = controls
input.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    required('#composer', HTMLFormElement).requestSubmit()
  }
}
required('#composer', HTMLFormElement).onsubmit = async (event) => {
  event.preventDefault()
  if (sendButton.disabled) return
  pending ??= { text: input.value.trim(), operationId: crypto.randomUUID() }
  if (await command({ type: 'send', ...pending })) {
    pending = undefined
    input.value = ''
    controls()
    input.focus()
  }
}
required('#new', HTMLButtonElement).onclick = () => void command({ type: 'new' })
required('#stop', HTMLButtonElement).onclick = () => void command({ type: 'stop' })
required('#history', HTMLButtonElement).onclick = () => void command({ type: 'history' })
required('#reconnect', HTMLButtonElement).onclick = () => void command({ type: 'reconnect' })
required('#signout', HTMLButtonElement).onclick = async () => {
  await command({ type: 'signout' })
  pending = undefined
  input.value = ''
  controls()
}
required('#mode', HTMLSelectElement).onchange = async (event) => {
  if (event.target instanceof HTMLSelectElement) {
    const mode = event.target.value === 'live' ? 'live' : 'fixture'
    if (await command({ type: 'mode', mode })) {
      pending = undefined
      input.value = ''
      controls()
    }
  }
}
const email = () => required('#email', HTMLInputElement).value.trim()
const invite = () => required('#invite', HTMLInputElement).value.trim()
required('#code', HTMLButtonElement).onclick = () => void command({ type: 'code', email: email(), invite: invite() })
required('#auth', HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  void command({
    type: 'verify',
    email: email(),
    otp: required('#otp', HTMLInputElement).value.trim(),
    invite: invite(),
  })
}
transcript.onscroll = () => {
  latest.hidden = nearBottom()
}
latest.onclick = () => {
  transcript.scrollTop = transcript.scrollHeight
}
let running = true
window.addEventListener('pagehide', () => {
  running = false
})
async function follow() {
  while (running) {
    const abort = new AbortController()
    try {
      const response = await fetch('/bridge/events', { headers, signal: abort.signal })
      if (response.status === 401) {
        status.textContent = 'Open this client through bun run launch so it receives the local connection key.'
        return
      }
      await readSse(response, abort.signal, (frame) => render(JSON.parse(frame.data)))
    } catch {
      status.textContent = 'Companion disconnected. Reconnecting…'
    } finally {
      abort.abort()
    }
    if (running) await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
void follow()
