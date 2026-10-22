import { Conflict, Forbidden, NotFound } from '@goblin/contracts/api'
import { describe, expect, it } from 'vitest'
import { invitationRefusal } from '../src/components/invitation-refusal.ts'
import { messageOf } from '../src/lib/query/app-error.ts'

const INVITATION = { workspace: 'Swarmm', invitedBy: 'Aurora' }

describe('the copy for a refused invitation answer', () => {
  it("says a workspace with its owner's own models takes no members", () => {
    expect(invitationRefusal(new Conflict({ reason: 'owner_models', ref: '7f3a9c12e4b5' }), INVITATION)).toBe(
      "Swarmm offers its owner's own subscription models, which serve only them, so it takes no members. · ref 7f3a9c12",
    )
  })

  it('names who to ask for a new one when it expired, and says when it was withdrawn or already answered', () => {
    expect(invitationRefusal(new Conflict({ reason: 'expired' }), INVITATION)).toBe(
      'This invitation has expired. Ask Aurora for a new one.',
    )
    expect(invitationRefusal(new Conflict({ reason: 'canceled' }), INVITATION)).toBe('This invitation was withdrawn.')
    expect(invitationRefusal(new Conflict({ reason: 'accepted' }), INVITATION)).toBe('You already joined Swarmm.')
    expect(invitationRefusal(new Conflict({ reason: 'declined' }), INVITATION)).toBe(
      'You already turned this invitation down.',
    )
  })

  it('says when it is for another address, or it or its workspace is gone', () => {
    expect(invitationRefusal(new Forbidden({ reason: 'invitation_email' }), INVITATION)).toBe(
      'This invitation is for another address.',
    )
    expect(invitationRefusal(new NotFound({ what: 'invitation' }), INVITATION)).toBe(
      'This invitation no longer exists.',
    )
    expect(invitationRefusal(new NotFound({ what: 'workspace' }), INVITATION)).toBe('Swarmm no longer exists.')
  })

  it('falls back to the failure in general for anything else', () => {
    for (const failure of [new Conflict({ reason: 'something_new' }), new TypeError('Failed to fetch')])
      expect(invitationRefusal(failure, INVITATION)).toBe(messageOf(failure, 'answer the invitation'))
  })
})
