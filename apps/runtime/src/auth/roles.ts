import { createAccessControl } from 'better-auth/plugins/access'
import { adminAc, defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access'

/**
 * What a member of a workspace may do in Better Auth's own records (ADR 0089): the organization plugin's statements,
 * and the key plugin's for a workspace's API keys, which only its owners and admins make, change and end.
 */
const ac = createAccessControl({ ...defaultStatements, apiKey: ['create', 'read', 'update', 'delete'] })

const KEYS = ['create', 'read', 'update', 'delete'] as const

export const workspaceAccess = {
  ac,
  roles: {
    owner: ac.newRole({ ...ownerAc.statements, apiKey: [...KEYS] }),
    admin: ac.newRole({ ...adminAc.statements, apiKey: [...KEYS] }),
    member: ac.newRole({ ...memberAc.statements }),
  },
} as const
