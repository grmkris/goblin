import { describe, expect, it } from 'vitest'
import { codemodeExtension } from '../src/pi/codemode.ts'
import { askUserExtension } from '../src/pi/ask-user.ts'

describe('durable code mode (spike)', () => {
  it('adds a model-only, replay-safe codemode tool backed by the sandbox binding', () => {
    const extension = codemodeExtension(
      {
        getByName: () => {
          throw new Error('not reached')
        },
      },
      () => 'agent-1',
    )
    const tool = extension.tools?.find((candidate) => candidate.name === 'codemode')
    expect(tool?.callers).toEqual(['model'])
    expect(tool?.replay).toBe('safe')
  })

  it('keeps ask_user callable by the model only', () => {
    const ask = askUserExtension.tools?.find((candidate) => candidate.name === 'ask_user')
    expect(ask?.callers).toEqual(['model'])
  })
})
