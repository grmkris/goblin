/** One model response's tokens by kind, as pi-ai reports them: `input` excludes the cached tokens in `cacheRead`. */
export type TokenUse = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** Every token of a response, whatever its kind. */
export const totalTokens = (use: TokenUse): number => use.input + use.output + use.cacheRead + use.cacheWrite
