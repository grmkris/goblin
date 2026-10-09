/** The narrow Workers AI boundary used by decisions; native `Ai` and injected fixtures satisfy it. */
export interface DecisionsBinding {
  readonly run: (
    model: '@cf/cloudflare/clef',
    input: {
      readonly model: 'clef'
      readonly state: string
      readonly questions: Readonly<
        Record<
          string,
          {
            readonly type: 'noul' | 'choice' | 'score'
            readonly instructions: string
            readonly criteria?: Readonly<Record<string, string>> | readonly string[]
          }
        >
      >
    },
  ) => Promise<unknown>
}
