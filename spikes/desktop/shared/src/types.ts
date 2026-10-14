export type HostName = 'browser' | 'tauri' | 'electrobun' | 'gpui'
export type Message = { id: string; role: 'user' | 'assistant' | 'tool'; text: string; label?: string }
export type Chat = { id: string; title: string; detail: string; messages: Message[] }
export type ViewState = {
  revision: number
  mode: 'fixture' | 'live'
  chats: Omit<Chat, 'messages'>[]
  selected: string
  title: string
  messages: Message[]
  streaming: boolean
  status: string
  history: boolean
  signedIn: boolean
  pendingOperation?: string
}
export type Command =
  | { type: 'send'; text: string; operationId: string }
  | { type: 'select'; id: string }
  | { type: 'mode'; mode: 'fixture' | 'live' }
  | { type: 'code'; email: string; invite?: string }
  | { type: 'verify'; email: string; otp: string; invite?: string }
  | { type: 'new' | 'stop' | 'history' | 'reconnect' | 'signout' }
export const hosts: HostName[] = ['browser', 'tauri', 'electrobun', 'gpui']
export function hostName(value: string | null): HostName {
  return hosts.find((host) => host === value) ?? 'browser'
}
