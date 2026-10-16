/**
 * Characters a reader cannot see: controls, format characters (bidi, Unicode tags, zero-width) other than the joiner
 * inside emoji, private use, unassigned, and the variation-selector supplement.
 */
const HIDDEN = /(?!‍)\p{C}|[\u{E0100}-\u{E01EF}]/u
/** Spacing that pads text out of sight: any space but a single plain one. */
const PADDING = /[^\S ]| {2}/u

/** The longest label a reply button or field may have; the label is what a click sends. */
export const maxLabelLength = 120

/** Model-written text a click sends as the owner's words (a label, an option, a default): one line, all of it shown. */
export const shownWhole = (text: string): boolean => !HIDDEN.test(text) && !PADDING.test(text)

/** Only the clicked button's visible label and mounted form controls become the owner's next message. */
export function replyMessage(label: string, values: Iterable<readonly [string, unknown]>): string | undefined {
  if (label.trim() === '' || label.length > maxLabelLength || !shownWhole(label)) return undefined
  const fields: { label: string; value: string }[] = []
  for (const [name, value] of values) {
    if (fields.length >= 20 || name.length > maxLabelLength || !shownWhole(name)) return undefined
    // The owner may have typed the value, spaces and all; nothing in it may be invisible.
    if (typeof value !== 'string' || value.length > 1000 || HIDDEN.test(value)) return undefined
    fields.push({ label: name, value })
  }
  const message = fields.length === 0 ? label : `${label}\n\nForm values:\n${JSON.stringify(fields)}`
  return message.length <= 12000 ? message : undefined
}
