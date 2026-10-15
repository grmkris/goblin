import { describe, expect, it } from 'vitest'
import { examples } from '../src/examples.ts'
import { maxSourceLength, programProblems } from '@goblin/web/replies'

describe('the fixture library', () => {
  for (const example of examples)
    it(`accepts the ${example.id} program`, () => expect(programProblems(example.source)).toEqual([]))

  it('reports undefined components and names instead of silently accepting an empty reply', () => {
    expect(programProblems('root = Stack([missing])')).not.toEqual([])
    expect(programProblems('root = UnknownWidget("hello")')).not.toEqual([])
  })

  it('refuses tool queries and mutations even when they are valid OpenUI', () => {
    expect(programProblems('root = Stack([])\nrows = Query("read_private_data", {}, [])')).not.toEqual([])
    expect(programProblems('root = Stack([])\nwrite = Mutation("send_message", {})')).not.toEqual([])
  })

  it('bounds source size and refuses hosted message bundles', () => {
    expect(programProblems('')).not.toEqual([])
    expect(programProblems('x'.repeat(maxSourceLength + 1))).not.toEqual([])
    expect(programProblems(']]>openui:content\nroot = Stack([])')).not.toEqual([])
  })
})
