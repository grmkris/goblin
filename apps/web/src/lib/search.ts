import { defaultStringifySearch } from '@tanstack/react-router'

type Plain = string | number | boolean

const isPlainList = (value: unknown): value is readonly Plain[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')

/**
 * The router's search written back as its default writes it, except a key that came more than once, which the parser
 * reads as a list of plain values: it stays repeated, never one JSON value. The authorization server signs its consent
 * query with repeated keys (`ba_param`), and on the server the router redirects to the address it writes back, so the
 * default turned that query into one the signature no longer holds for.
 */
export const stringifySearch = (search: Record<string, unknown>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (isPlainList(value)) for (const item of value) params.append(key, String(item))
    else
      for (const [name, text] of new URLSearchParams(defaultStringifySearch({ [key]: value })))
        params.append(name, text)
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}
