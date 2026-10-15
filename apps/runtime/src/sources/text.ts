// A Source answer leaving goblin through a server's tool: an operation id the server accepts
// and the answer cut into pieces the server takes.

/** An operation id servers accept: `<prefix>-<id>`, each character but letters, digits, `_` and `-` as `-`, at most 100. */
export const operationIdOf = (prefix: string, id: string) => `${prefix}-${id.replaceAll(/[^\w-]/gu, '-')}`.slice(0, 100)

/** `text` in pieces of at most `max` UTF-16 code units, preserving code points and preferring paragraph/line breaks. */
export function chunks(text: string, max: number): readonly string[] {
  const pieces: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    // `String#slice` counts UTF-16 code units and can cut an astral code point in half. Keep the source reply valid
    // Unicode even when a server's chunk boundary lands between a surrogate pair.
    let end = max
    const unit = rest.charCodeAt(end)
    if (unit >= 0xdc00 && unit <= 0xdfff) end -= 1
    const window = rest.slice(0, end)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'))
    const at = cut > max / 2 ? cut : end
    pieces.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest !== '') pieces.push(rest)
  return pieces
}
