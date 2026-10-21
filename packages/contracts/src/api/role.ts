import * as Context from 'effect/Context'

/**
 * The least role an owner endpoint needs (ADR 0093): `member` for working in the workspace, `admin` for changing what
 * its agent may do (its connections and grants, Sources, model, Start, resident authority). An owner counts as an
 * admin. Owner admission refuses a member below it (`Forbidden`, `role`), and an OAuth client acting for that member.
 */
export const EndpointRole = Context.Reference<'member' | 'admin'>('goblin/api/EndpointRole', {
  defaultValue: () => 'member',
})
