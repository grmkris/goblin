import { describe, expect, it } from 'vitest'
import { createParser, parseMessage } from '@openuidev/react-lang'
import { library } from '../src/components/parts/openui/library.tsx'
import { checkProgram, programProblems } from '../src/components/parts/openui/program.ts'
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
  it('refuses a message marker spelled with escapes', () => {
    expect(programProblems('root = Stack([Heading("]\\u005d>openui:content", "")])')).not.toEqual([])
  })
})

/** The program a reply draws, or the reasons it stays code as a failure. */
function drawn(source: string): string {
  const checked = checkProgram(source)
  if (!checked.ok) throw new Error(checked.problems.join('; '))
  return checked.program
}

describe('the program the Renderer draws', () => {
  const parser = createParser(library.toJSONSchema(), library.root)
  const decoy = {
    typeName: 'Stack',
    props: { children: [{ typeName: 'Heading', props: { title: 'A', description: 'B' } }] },
  }
  // OpenUI strips comments and fences before parsing; the checker's tokenizer reads both as part of a string.
  const fanOut = ['root = Stack([n0, n0, n0, n0, n0, n0, n0, n0, n0, n0])']
  for (let i = 0; i < 7; i++)
    fanOut.push(`n${i} = Stack([${Array.from({ length: 10 }, () => `n${i + 1}`).join(', ')}])`)
  fanOut.push('n7 = Heading("x", "y")')
  it.each([
    [
      'a comment',
      `root = Stack([Heading("A", "B")])\npad = #'\n$x = "a"\nroot = Stack([Heading($x == "a" ? "t" : "f", "")])\n#'`,
    ],
    [
      'a fence',
      `root = Stack([Heading("A", "B")])\npad = '\`\`\`\nroot = Stack([Heading($x == "a" ? "t" : "f", "")])\n\`\`\`'`,
    ],
    ['an exponential fan-out', `root = Stack([Heading("A", "B")])\npad = #'\n${fanOut.join('\n')}\n#'`],
  ])('draws only what was checked when %s hides another program', (_, source) => {
    const program = drawn(source)
    expect(parser.parse(program).root).toMatchObject(decoy)
    expect(parseMessage(program).content).toBe(program)
    expect(drawn(program)).toBe(program)
  })
  it('prints a form with its state bindings and literals intact', () => {
    expect(drawn(form)).toBe(
      'root = Stack([Heading("Weekend", "Tell me the details"), field, ActionButton("Plan my weekend")])\n' +
        '$city = "Lisbon"\nfield = TextField("city", "Destination", $city)',
    )
    expect(
      drawn('root = Stack([n, c])\n$t = -5\nn = NumberField("t", "Temp", $t, -10, 10)\nc = Chart(\'{"a": 1}\')'),
    ).toBe('root = Stack([n, c])\n$t = -5\nn = NumberField("t", "Temp", $t, -10, 10)\nc = Chart("{\\"a\\": 1}")')
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
