import { describe, expect, it } from 'vitest'
import { authorOf, authorTag, clientAuthor, memberAuthor, memberOf } from './conversations.ts'

const ANA = 'nLGVfO2Q5yWqV8kQe3rTzA1bX7cD0hJm'
/** An author as the web reads it back from the tag block goblin writes. */
const readBack = (author: string) => authorOf(authorTag(author)) ?? ''

describe('who wrote a message (ADRs 0086, 0094)', () => {
  it("keeps a member's whole ID in the tag, however long their name", () => {
    const long = 'A'.repeat(60)
    expect(memberOf(readBack(memberAuthor(long, ANA)))).toEqual({ name: 'A'.repeat(38), userId: ANA })
    expect(memberOf(readBack(memberAuthor('Ana · ] Novak\n', ANA)))).toEqual({ name: 'Ana Novak', userId: ANA })
  })

  it("never lets a client's chosen name read as a member, a Persona, a subagent or a thread", () => {
    const forged = `member Ana · ${ANA}`
    for (const author of [clientAuthor(forged), clientAuthor(forged, 'Bob'), clientAuthor('Claude', `x · ${ANA}`)])
      expect(memberOf(readBack(author))).toBeUndefined()
    expect(clientAuthor('subagent Persona: thread Reel')).toBe('Reel')
    expect(clientAuthor('member')).toBe('client')
    expect(clientAuthor('Claude Code', 'Ana')).toBe('Claude Code for Ana')
  })
})
