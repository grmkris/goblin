// The words of a message as they leave goblin through a server's tool, shared by the Telegram channel and Sources: an
// operation id a server accepts, and an answer cut into the pieces the server takes.

/** An operation id servers accept: `<prefix>-<id>`, each character but letters, digits, `_` and `-` as `-`, at most 100. */
export const operationIdOf = (prefix: string, id: string) => `${prefix}-${id.replaceAll(/[^\w-]/gu, '-')}`.slice(0, 100)

/** `text` in pieces of at most `max` characters, split at paragraph or line breaks where it can. */
export function chunks(text: string, max: number): readonly string[] {
  const pieces: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
    const at = cut > max / 2 ? cut : max
    pieces.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}
