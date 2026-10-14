import type { Command } from '../shared/src/types'
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function field(value: Record<string, unknown>, key: string, max: number): string {
  const v = value[key]
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error(`Invalid ${key}`)
  return v
}
export function commandOf(value: unknown): Command {
  if (!record(value)) throw new Error('Invalid command')
  const type = value.type
  const str = (key: string, max: number) => field(value, key, max)
  switch (type) {
    case 'send': {
      const operationId = str('operationId', 100)
      if (!/^[a-zA-Z0-9_-]+$/.test(operationId)) throw new Error('Invalid operationId')
      return { type, text: str('text', 20000), operationId }
    }
    case 'select':
      return { type, id: str('id', 100) }
    case 'mode':
      if (value.mode !== 'fixture' && value.mode !== 'live') throw new Error('Invalid mode')
      return { type, mode: value.mode }
    case 'code':
    case 'verify': {
      const email = str('email', 254)
      const invite = typeof value.invite === 'string' ? value.invite.slice(0, 200) : ''
      return type === 'code' ? { type, email, invite } : { type, email, invite, otp: str('otp', 32) }
    }
    case 'new':
    case 'stop':
    case 'history':
    case 'reconnect':
    case 'signout':
      return { type }
    default:
      throw new Error('Unknown command')
  }
}
