// The owner's pins for components (ADRs 0053, 0078): every stored pin with its state, whether something is pinned, and
// the edits. An edit starts from the pins the feed holds; when another device changed them first, it is made again,
// once, from the pins that answer brings.
import { useMemo } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { type SidebarOperation, type SidebarPin, type SidebarPins, type SidebarTarget, pinKey } from '@goblin/contracts'
import { type ShownPin, moveOperation, pinnedRows } from '../lib/pins.ts'
import { useApps, useSidebarPins } from '../lib/workspace/hooks.ts'
import { editWorkspaceSidebarMutation } from '../lib/workspace/mutations.ts'
import { serversQuery } from '../mcp/queries.ts'

/** What the owner can do with the pins, and the pins as they show. */
export type Pins = {
  readonly shown: readonly ShownPin[]
  readonly isPinned: (target: SidebarTarget) => boolean
  readonly pin: (pin: SidebarPin) => void
  readonly unpin: (target: SidebarTarget) => void
  /** Moves a pin one place up (`-1`) or down (`1`); nothing at either end. */
  readonly move: (target: SidebarTarget, step: -1 | 1) => void
  /** Whether a pin can move that way. */
  readonly canMove: (target: SidebarTarget, step: -1 | 1) => boolean
  readonly pending: boolean
}

export function usePins(): Pins {
  const stored = useSidebarPins()
  const servers = useQuery(serversQuery).data
  const apps = useApps()
  const shown = useMemo(() => pinnedRows(stored, servers, apps), [stored, servers, apps])
  const editing = useMutation(editWorkspaceSidebarMutation)
  const { mutateAsync } = editing
  return useMemo(() => {
    const run = (operation: (pins: SidebarPins) => SidebarOperation | undefined) => {
      const first = operation(stored)
      if (first === undefined) return
      mutateAsync({ expectedRevision: stored.revision, op: first })
        .then((answer) => {
          if (answer.kind !== 'stale') return undefined
          const again = operation(answer.sidebar)
          return again === undefined ? undefined : mutateAsync({ expectedRevision: answer.sidebar.revision, op: again })
        })
        // expected: the mutation's own onError shows a refusal in the feed's status; nothing is left to do here
        .catch(() => undefined)
    }
    const storedKeys = new Set(stored.pins.map(pinKey))
    return {
      shown,
      isPinned: (target) => storedKeys.has(pinKey(target)),
      pin: (pin) => run(() => ({ kind: 'pin', pin })),
      unpin: (target) => run(() => ({ kind: 'unpin', target })),
      move: (target, step) => run((pins) => moveOperation(pins, target, step)),
      canMove: (target, step) => moveOperation(stored, target, step) !== undefined,
      pending: editing.isPending,
    }
  }, [stored, shown, mutateAsync, editing.isPending])
}
