// Open from wherever the owner meets an App outside its conversation (Apps, a pin), in one step: a closed App is
// opened again first, then its page shows. The App page's own "Open again" stays for a direct link to a closed one.
import { useMutation } from '@tanstack/react-query'
import type { AppView } from '@goblin/contracts'
import { useNavigation } from '../../lib/navigation.ts'
import { closeWorkspaceAppMutation } from '../../lib/workspace/mutations.ts'

/**
 * Opens App `app`'s page, reopening it first when it was closed. `pending` while a reopen is under way; `error` is why
 * it could not be reopened, if it could not (the App then stays closed, as the feed has it).
 */
export function useOpenApp() {
  const { openApp } = useNavigation()
  const reopening = useMutation(closeWorkspaceAppMutation)
  const { mutate } = reopening
  return {
    open: (app: AppView) => {
      if (app.closedAt === undefined) openApp(app.id)
      else mutate({ id: app.id, closed: false }, { onSuccess: () => openApp(app.id) })
    },
    pending: reopening.isPending,
    error: reopening.error,
  }
}
