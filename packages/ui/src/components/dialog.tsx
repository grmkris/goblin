// Ported from myapps' Base UI dialog (shadcn base-nova): a focused reading surface with the shared chrome tokens.
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { cn } from '../lib/cn'

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

/** An inline panel with the dialog's focus and dismissal behavior; its container owns placement. */
function DialogPanel({
  container,
  className,
  ...props
}: DialogPrimitive.Popup.Props & { readonly container: DialogPrimitive.Portal.Props['container'] }) {
  return (
    <DialogPrimitive.Portal container={container} className="contents">
      <DialogPrimitive.Popup
        data-slot="dialog-panel"
        className={cn(
          'relative z-[calc(var(--z-chrome)+1)] flex w-[min(25rem,100%)] min-w-0 shrink-0 flex-col border-s border-border bg-background shadow-(--shadow-2) outline-none',
          '@max-[54rem]/channel:absolute @max-[54rem]/channel:inset-y-0 @max-[54rem]/channel:end-0 @max-[42rem]/channel:w-full @max-[42rem]/channel:border-s-0',
          'max-md:fixed max-md:inset-0 max-md:w-full max-md:border-0 max-md:shadow-none',
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  )
}

function DialogContent({ className, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-backdrop"
        className="fixed inset-0 z-(--z-overlay) bg-black/10 transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-100 supports-backdrop-filter:backdrop-blur-xs"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-(--z-overlay) flex max-h-[85dvh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-popover p-4 text-popover-foreground shadow-(--shadow-3) ring-1 ring-foreground/10 outline-none transition-[scale,opacity] duration-200 data-starting-style:scale-[0.96] data-starting-style:opacity-0 data-ending-style:scale-[0.96] data-ending-style:opacity-0 data-ending-style:duration-150',
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title data-slot="dialog-title" className={cn('text-base font-medium', className)} {...props} />
  )
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export { Dialog, DialogClose, DialogContent, DialogPanel, DialogTitle, DialogDescription }
