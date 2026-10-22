/**
 * Bounded plain text for passive reports and notices: terminal and bidi control characters stripped, cut to 1600
 * characters. Links and anything that looks like a credential stay as written (ADR 0104).
 */
export function routineSummary(text: string): string {
  return (
    text
      // oxlint-disable-next-line no-control-regex -- passive report text must strip terminal and bidi controls.
      .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu, '')
      .trim()
      .slice(0, 1600)
  )
}
