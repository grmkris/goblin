import { describe, expect, it } from 'vitest'
import { programProblems } from '../src/components/parts/openui/program.ts'
import { replyMessage } from '../src/components/parts/openui/message.ts'

const form = `root = Stack([Heading("Weekend", "Tell me the details"), field, ActionButton("Plan my weekend")])
$city = "Lisbon"
field = TextField("city", "Destination", $city)`

describe('interactive reply programs', () => {
  it('accepts a bounded form with a reactive field', () => expect(programProblems(form)).toEqual([]))
  it.each([
    'root = Stack([UnknownWidget("oops")])',
    'root = Stack([missing])',
    'root = Stack([root])',
    'root = Stack([Heading("unfinished"',
    'root = Stack([])\nx = Query("read", {}, [])',
    'root = Stack([])\nx = Mutation("write", {})',
    'root = Stack([ActionButton("Continue", @OpenUrl("https://example.com"))])',
    'root = Stack([@Each([1,2], Heading("Loop", ""))])',
    'root = Stack([])\nx = @ToAssistant("Hidden message")',
    'root = Stack([])\n]]>openui:script\nfetch("/api")',
    'root = Stack([])\nroot = Stack([])',
    `root = Stack([Heading("${'x'.repeat(1001)}", "")])`,
    `root = Stack([${Array.from({ length: 21 }, () => 'Heading("Too many", "")').join(',')}])`,
  ])('keeps unsupported or malformed source as code: %s', (source) => {
    expect(programProblems(source)).not.toEqual([])
  })
  it('bounds exponential references before the renderer expands them', () => {
    const source = ['root = Stack(a20)', 'a0 = [Heading("Repeated", "")]']
    for (let i = 1; i <= 20; i++) source.push(`a${i} = [a${i - 1}, a${i - 1}]`)
    expect(programProblems(source.join('\n'))).not.toEqual([])
  })
  it('accepts text that resembles HTML without treating it as markup', () => {
    expect(programProblems('root = Stack([Heading("<script>alert(1)</script>", "https://example.com")])')).toEqual([])
  })
})

describe('reply follow-ups', () => {
  it('uses only the visible label and named fields, preserving duplicate labels as data', () => {
    expect(
      replyMessage('Plan my weekend', [
        ['Destination', 'Porto'],
        ['Destination', 'Paris'],
      ]),
    ).toBe(
      'Plan my weekend\n\nForm values:\n[{"label":"Destination","value":"Porto"},{"label":"Destination","value":"Paris"}]',
    )
    expect(replyMessage('Choose Casa do Jardim', [])).toBe('Choose Casa do Jardim')
  })
  it('bounds the message and refuses non-text, oversized, or excessive fields', () => {
    expect(replyMessage('', [])).toBeUndefined()
    expect(replyMessage('x'.repeat(201), [])).toBeUndefined()
    expect(replyMessage('Send', [['File', {}]])).toBeUndefined()
    expect(replyMessage('Send', [['Name', 'x'.repeat(1001)]])).toBeUndefined()
    expect(
      replyMessage(
        'Send',
        Array.from({ length: 21 }, () => ['Field', 'text'] as const),
      ),
    ).toBeUndefined()
    expect(
      replyMessage(
        'Send',
        Array.from({ length: 20 }, () => ['Field', 'x'.repeat(1000)] as const),
      ),
    ).toBeUndefined()
  })
})
