import { createAccessControl } from 'better-auth/plugins/access'
import { adminAc, defaultStatements, memberAc, ownerAc } from 'better-auth/plugins/organization/access'

/**
 * What a member of a workspace may do in Better Auth's own records (ADR 0089): the organization plugin's statements.
 */
const ac = createAccessControl({ ...defaultStatements })

export const workspaceAccess = {
  ac,
  roles: {
    owner: ac.newRole({ ...ownerAc.statements }),
    admin: ac.newRole({ ...adminAc.statements }),
    member: ac.newRole({ ...memberAc.statements }),
  },
} as const
