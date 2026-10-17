// Base UI's Autocomplete as a search with its results listed under it, inline in a dialog (a quick switcher): one
// field, grouped rows, the highlighted row the one Enter opens. Styled as shadcn's base-nova combobox and this
// package's menus; the caller filters and ranks the items itself.
import { Autocomplete as AutocompletePrimitive } from '@base-ui/react/autocomplete'
import type { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import type { ComponentProps } from 'react'
import { SearchIcon } from 'lucide-react'
import { cn } from '../lib/cn'
import { DialogContent } from './dialog'

const Autocomplete = AutocompletePrimitive.Root

/**
 * The dialog a search sits in: anchored near the top rather than centred, so it stays put while the results under the
 * field grow and shrink; edge to edge, its rows inset by the list's own padding.
 */
function AutocompleteDialog({ className, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogContent
      data-slot="autocomplete-dialog"
      className={cn(
        'top-[min(14dvh,7rem)] w-[min(36rem,calc(100vw-2rem))] translate-y-0 gap-0 overflow-hidden p-0',
        className,
      )}
      {...props}
    />
  )
}

/** The search field: a magnifier and a borderless input across the top, a hairline under it. */
function AutocompleteInput({ className, ...props }: AutocompletePrimitive.Input.Props) {
  return (
    <AutocompletePrimitive.InputGroup
      data-slot="autocomplete-input-group"
      className="flex items-center gap-2.5 border-b border-hairline px-4"
    >
      <SearchIcon aria-hidden className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      <AutocompletePrimitive.Input
        data-slot="autocomplete-input"
        className={cn(
          'h-12 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-15',
          className,
        )}
        {...props}
      />
    </AutocompletePrimitive.InputGroup>
  )
}

/** The results, scrolling on their own under the field. */
function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return (
    <AutocompletePrimitive.List
      data-slot="autocomplete-list"
      className={cn(
        'max-h-[min(26rem,60dvh)] scroll-py-1.5 overflow-y-auto overscroll-contain p-1.5 data-empty:p-0',
        className,
      )}
      {...props}
    />
  )
}

function AutocompleteGroup({ className, ...props }: AutocompletePrimitive.Group.Props) {
  return (
    <AutocompletePrimitive.Group
      data-slot="autocomplete-group"
      className={cn('not-first:mt-1.5', className)}
      {...props}
    />
  )
}

function AutocompleteGroupLabel({ className, ...props }: AutocompletePrimitive.GroupLabel.Props) {
  return (
    <AutocompletePrimitive.GroupLabel
      data-slot="autocomplete-group-label"
      className={cn('px-2.5 pt-1.5 pb-1 text-13 font-semibold text-muted-foreground', className)}
      {...props}
    />
  )
}

const AutocompleteCollection = AutocompletePrimitive.Collection

/**
 * One result: at least 40px tall at a mouse and 44px on touch, its corners inset from the list's (6px inside 12px).
 * The highlight follows the keyboard and the pointer alike and changes at once, as a menu's does: a fading highlight
 * would show two rows lit while the owner types or holds an arrow key. An icon directly in the row is muted and 16px.
 */
function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        "group/autocomplete-item relative flex min-h-10 cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-15 outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-4 [&>svg:not([class*='text-'])]:text-muted-foreground pointer-coarse:min-h-11",
        className,
      )}
      {...props}
    />
  )
}

/** A result's name, cut short with an ellipsis when the row is too narrow; its full text stays its accessible name. */
function AutocompleteItemLabel({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="autocomplete-item-label" className={cn('min-w-0 flex-1 truncate', className)} {...props} />
}

/** What a result is and where, in words at the row's end ("Thread in #Travel"). */
function AutocompleteItemDetail({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="autocomplete-item-detail"
      className={cn(
        'max-w-1/2 shrink-0 truncate text-13 text-muted-foreground tabular-nums group-data-highlighted/autocomplete-item:text-accent-foreground/70',
        className,
      )}
      {...props}
    />
  )
}

function AutocompleteEmpty({ className, ...props }: AutocompletePrimitive.Empty.Props) {
  return (
    <AutocompletePrimitive.Empty
      data-slot="autocomplete-empty"
      className={cn('px-4 py-6 text-center text-sm text-muted-foreground empty:hidden', className)}
      {...props}
    />
  )
}

export {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteDialog,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteItemDetail,
  AutocompleteItemLabel,
  AutocompleteList,
}
