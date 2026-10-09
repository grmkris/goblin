import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.ts'
import { HELLO, HELP, LOCAL_COMMANDS, replyOf } from '../src/commands.ts'

/** The help's line for a command, or the empty text when the help does not list it. */
const lineFor = (command: string): string =>
  HELP.split('\n').find((line) => line.startsWith(`  goblin ${command}`)) ?? ''

/** A help line's description: what follows the run of spaces that lines up the commands. */
const descriptionOf = (command: string): string => lineFor(command).trim().split(/ {2,}/u).slice(1).join(' ')

/** The column a help line's description starts at, to catch a command listed out of line. */
const columnOf = (command: string): number => lineFor(command).indexOf(descriptionOf(command))

describe('goblin hello (unit)', () => {
  it('greets with exactly one line, and nothing else is answered locally', () => {
    expect(HELLO).toBe('Hello, world!')
    expect(replyOf('hello')).toBe('Hello, world!')
    expect(replyOf('hello').split('\n')).toHaveLength(1)
    expect(LOCAL_COMMANDS).toEqual(['help', 'hello'])
  })

  it('is parsed as its own command and greeted before any settings', () => {
    expect(parseArgs(['hello']).command).toBe('hello')
    expect(parseArgs(['hello']).positionals).toEqual([])
    // a line nothing could sign in to, because the greeting never reaches the origin, the port or the store
    expect(replyOf(parseArgs(['hello', '--origin', 'not a url', '--port', '9']).command)).toBe(HELLO)
    expect(replyOf(parseArgs(['hello', '--json']).command)).toBe(HELLO)
  })

  it('is listed in the help, in line with the other commands', () => {
    expect(replyOf(undefined)).toBe(HELP)
    expect(replyOf('help')).toBe(HELP)
    expect(descriptionOf('hello')).toBe('print a greeting and exit (no sign-in, no network)')
    expect(columnOf('hello')).toBe(columnOf('login'))
  })

  it('leaves every command that needs the agent to the connection', () => {
    const remote = ['login', 'logout', 'tools', 'turn', 'problems', 'conversation', 'logs', 'ask_agent']
    for (const command of remote) expect(LOCAL_COMMANDS).not.toContain(command)
  })
})
