// Servers we suggest, on a shelf in groups (ADR 0052): OAuth discovery is checked from a Worker, or the endpoint needs
// no sign-in. Credential-backed acceptance is separate. Descriptions are ours, not the servers'. The shelf only adds
// them; grants still start empty. It is data: one endpoint per entry, the same on every deployment, which a deployment
// may change or add to with `MCP_SHELF`.
import { ServerGroup, type ServerSuggestion } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { Internal } from '../http/errors.ts'

/** One server on the shelf, as `MCP_SHELF` gives one too. */
const ShelfEntry = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  description: Schema.String.check(Schema.isMaxLength(300)),
  endpoint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  group: ServerGroup,
  signIn: Schema.Boolean,
})
export type ShelfEntry = typeof ShelfEntry.Type

const decodeShelf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(ShelfEntry)))

/**
 * Reviewed 2026-10-12: every server that needs no sign-in answered an `initialize` without credentials that day. Live
 * acceptance is recorded separately.
 */
const SHELF: readonly ShelfEntry[] = [
  {
    // One OAuth for all of the owner's my* apps; `codemode=off` keeps every app's tools listed by name
    // (`<service>_<tool>`), under the same OAuth resource as plain /mcp.
    id: 'mysi',
    title: 'mysi',
    description: 'Your my* apps in one connection: notes, browsers, Telegram, email, skills and terminals.',
    endpoint: 'https://mysi.lol/mcp?codemode=off',
    group: 'yours',
    signIn: true,
  },
  {
    // OAuth with dynamic registration, checked 2026-10-12; Choose access offers its Workers scopes.
    id: 'cloudflare',
    title: 'Cloudflare',
    description: 'Publish a page or a small app as a Worker on your Cloudflare account.',
    endpoint: 'https://mcp.cloudflare.com/mcp',
    group: 'publish',
    signIn: true,
  },
  {
    id: 'kiwi',
    title: 'Kiwi.com',
    description: 'Flight search across airlines, with prices and a booking link for each option.',
    endpoint: 'https://mcp.kiwi.com',
    group: 'travel',
    signIn: false,
  },
  {
    // Its replies carry a `system_message` meant for the model: like every remote result, it is data, never instructions.
    id: 'trivago',
    title: 'trivago',
    description: 'Hotels and their prices across booking sites, in a view you can browse.',
    endpoint: 'https://mcp.trivago.com/mcp',
    group: 'travel',
    signIn: false,
  },
  {
    id: 'ferryhopper',
    title: 'Ferryhopper',
    description: 'Ferry routes, times and prices, mostly around Europe, in a view you can browse.',
    endpoint: 'https://mcp.ferryhopper.com/mcp',
    group: 'travel',
    signIn: false,
  },
  {
    id: 'wikidata',
    title: 'Wikidata',
    description: 'Facts about people, places and works, and how they connect, from Wikidata.',
    endpoint: 'https://wd-mcp.wmcloud.org/mcp',
    group: 'knowledge',
    signIn: false,
  },
  {
    id: 'microsoft-learn',
    title: 'Microsoft Learn',
    description: "Microsoft's documentation and code samples: Azure, .NET, Microsoft 365 and the rest.",
    endpoint: 'https://learn.microsoft.com/api/mcp',
    group: 'knowledge',
    signIn: false,
  },
  {
    id: 'aws-knowledge',
    title: 'AWS Knowledge',
    description: 'AWS documentation and guidance, and which services each region offers.',
    endpoint: 'https://knowledge-mcp.global.api.aws',
    group: 'knowledge',
    signIn: false,
  },
  {
    id: 'huggingface',
    title: 'Hugging Face',
    description: 'Search models, datasets and Spaces on Hugging Face, and read their files.',
    endpoint: 'https://huggingface.co/mcp',
    group: 'knowledge',
    signIn: false,
  },
  {
    id: 'coingecko',
    title: 'CoinGecko',
    description: "Crypto prices, market caps and coin details from CoinGecko's public data.",
    endpoint: 'https://mcp.api.coingecko.com/mcp',
    group: 'crypto',
    signIn: false,
  },
  {
    id: 'etherscan',
    title: 'Etherscan',
    description: 'Balances, transactions and contracts on Ethereum and other EVM chains, on its keyless tier.',
    endpoint: 'https://mcp-keyless.etherscan.io/mcp',
    group: 'crypto',
    signIn: false,
  },
  {
    id: 'excalidraw',
    title: 'Excalidraw',
    description: 'Hand-drawn diagrams your agent sketches, live in the chat.',
    endpoint: 'https://mcp.excalidraw.com/mcp',
    group: 'apps',
    signIn: false,
  },
  {
    id: 'subwayinfo',
    title: 'SubwayInfo.nyc',
    description: 'New York transit: live subway, bus, ferry and rail arrivals, alerts and trip plans.',
    endpoint: 'https://subwayinfo.nyc/mcp',
    group: 'apps',
    signIn: false,
  },
  {
    id: 'deepwiki',
    title: 'DeepWiki',
    description: 'Questions about any public GitHub repository, answered from its generated wiki.',
    endpoint: 'https://mcp.deepwiki.com/mcp',
    group: 'code',
    signIn: false,
  },
  {
    id: 'context7',
    title: 'Context7',
    description: 'Current documentation and code examples for programming libraries.',
    endpoint: 'https://mcp.context7.com/mcp',
    group: 'code',
    signIn: false,
  },
  {
    id: 'cloudflare-docs',
    title: 'Cloudflare Docs',
    description: "Search Cloudflare's developer documentation.",
    endpoint: 'https://docs.mcp.cloudflare.com/mcp',
    group: 'code',
    signIn: false,
  },
  {
    id: 'svelte',
    title: 'Svelte',
    description: 'Svelte and SvelteKit documentation, and a checker that fixes Svelte code.',
    endpoint: 'https://mcp.svelte.dev/mcp',
    group: 'code',
    signIn: false,
  },
]

/**
 * An endpoint as the shelf compares it: its origin and path, without a query or a trailing slash. A connection made
 * before a suggestion gained a query (mysi's `?codemode=off`) reaches the same server, so it counts as added.
 */
const served = (endpoint: string): string => {
  try {
    const url = new URL(endpoint)
    return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
  } catch {
    // expected: an endpoint the URL parser refuses is compared as it was stored
    return endpoint
  }
}

/**
 * The deployment's shelf: goblin's, with each entry of `json` (`MCP_SHELF`, a JSON list of entries) in place of the one
 * with its id, or added after them. A list that does not decode stops the start, as a bad `MCP_SERVERS` does.
 */
export const shelfOf = (json: string | undefined): readonly ShelfEntry[] => {
  if (json === undefined || json.trim() === '') return SHELF
  let given: readonly ShelfEntry[]
  try {
    given = decodeShelf(json)
  } catch {
    throw new Internal({ reason: 'MCP_SHELF is not a valid shelf' })
  }
  const byId = new Map(given.map((entry) => [entry.id, entry]))
  const kept = SHELF.map((entry) => byId.get(entry.id) ?? entry)
  return [...kept, ...given.filter((entry) => !SHELF.some((own) => own.id === entry.id))]
}

/** `shelf`, each entry marked added when one of `endpoints` already serves it. */
export function suggestions(shelf: readonly ShelfEntry[], endpoints: ReadonlySet<string>): readonly ServerSuggestion[] {
  const offered = new Set([...endpoints].map(served))
  return shelf.map((entry) => ({ ...entry, added: offered.has(served(entry.endpoint)) }))
}

/**
 * goblin's title for the server a suggestion on `shelf` reaches at `endpoint`: the name a connection added from the
 * shelf starts from, where the server's own card or host would read as an address ("mcp.kiwi.com").
 */
export function suggestedTitle(shelf: readonly ShelfEntry[], endpoint: string): string | undefined {
  const wanted = served(endpoint)
  return shelf.find((entry) => served(entry.endpoint) === wanted)?.title
}
