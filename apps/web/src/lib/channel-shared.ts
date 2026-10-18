import type { ChatMessage } from './chat-messages.ts'
import { fileUrl, fileSize } from './files.ts'
import { receivedFiles } from './tool-payload.ts'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export type SharedItem = {
  readonly key: string
  readonly kind: 'media' | 'file' | 'link'
  readonly name: string
  readonly detail: string
  readonly href: string
  readonly conversation: string
  readonly message: string
}
type LinkNode = {
  readonly type: string
  readonly url?: string
  readonly alt?: string | null | undefined
  readonly identifier?: string
  readonly value?: string
  readonly children?: readonly LinkNode[]
}
const parser = unified().use(remarkParse).use(remarkGfm)
const words = (node: LinkNode): string => node.value ?? node.children?.map(words).join('') ?? ''

/** Parse the same Markdown grammar as replies. Never load remote previews or accept executable URLs. */
function linksIn(text: string): { href: string; name: string; media: boolean }[] {
  const nodes: LinkNode[] = []
  const stack: LinkNode[] = [parser.parse(text)]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    nodes.push(node)
    stack.push(...(node.children ?? []))
  }
  const definitions = new Map(
    nodes.filter((node) => node.type === 'definition').map((node) => [node.identifier, node.url]),
  )
  return nodes.flatMap((node) => {
    if (!['link', 'linkReference', 'image', 'imageReference'].includes(node.type)) return []
    const url = node.url ?? definitions.get(node.identifier)
    const parsed = url === undefined ? null : URL.parse(url)
    if (parsed === null || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      return []
    return [
      { href: parsed.href, name: node.alt || words(node) || parsed.hostname, media: node.type.startsWith('image') },
    ]
  })
}

function textOf(message: ChatMessage): string {
  switch (message.role) {
    case 'user':
      return [message.text, ...(message.context ?? []).map((item) => item.text)].join('\n')
    case 'assistant':
    case 'tool':
      return message.text
    case 'persona':
      return message.answer.text
    case 'notice':
      return `${message.notice.title}\n${message.notice.body ?? ''}\n${message.notice.url ?? ''}`
    case 'delegate-result':
      return message.result.text
    case 'topic-seed':
      return [message.seed.brief, ...message.seed.sources.map((source) => source.excerpt)].join('\n')
    case 'thread-head':
    case 'thread-started':
      return ''
  }
}

/** Project visible transcript messages only; attachments use the same validated shapes as the conversation. */
export function sharedItems(messages: readonly ChatMessage[], conversation: string): SharedItem[] {
  return messages.flatMap((message) => {
    const files =
      message.role === 'user'
        ? (message.attachments ?? [])
        : message.role === 'tool'
          ? receivedFiles(message.details)
          : []
    const origin = { conversation, message: message.id }
    const items: SharedItem[] = files.map((file) => ({
      ...origin,
      key: `${message.id}:${file.path}`,
      kind: /^(?:image|audio|video)\//u.test(file.mimeType) ? 'media' : 'file',
      name: file.name,
      detail: fileSize(file.size),
      href: fileUrl(file.path),
    }))
    for (const link of linksIn(textOf(message)))
      items.push({
        ...origin,
        key: `${message.id}:${link.href}`,
        kind: link.media ? 'media' : 'link',
        name: link.name,
        detail: new URL(link.href).hostname,
        href: link.href,
      })
    return [...new Map(items.map((item) => [item.key, item])).values()]
  })
}
