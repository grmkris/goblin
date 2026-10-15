/** Only the clicked button's visible label and mounted form controls become the owner's next message. */
export function replyMessage(label: string, values: Iterable<readonly [string, unknown]>): string | undefined {
  if (label.trim() === '' || label.length > 200) return undefined
  const fields: { label: string; value: string }[] = []
  for (const [name, value] of values) {
    if (fields.length >= 20 || name.length > 1000 || typeof value !== 'string' || value.length > 1000) return undefined
    fields.push({ label: name, value })
  }
  const message = fields.length === 0 ? label : `${label}\n\nForm values:\n${JSON.stringify(fields)}`
  return message.length <= 12000 ? message : undefined
}
