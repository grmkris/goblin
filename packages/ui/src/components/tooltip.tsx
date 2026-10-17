// After shadcn/ui's base-nova tooltip (MIT), over Base UI's Tooltip: a short name for a control that shows only an
// icon, beside it on hover or keyboard focus. The control keeps its own accessible name; the tooltip only repeats it.
import * as React from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { cn } from '../lib/cn'

/** Tooltips under one provider share their delay: once one shows, the next shows at once. */
function TooltipProvider({ delay = 400, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider delay={delay} {...props} />
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = 'right',
  sideOffset = 8,
  align = 'center',
  ...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        className="isolate z-(--z-overlay)"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'z-(--z-overlay) max-w-64 origin-(--transform-origin) rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md transition-[scale,opacity] duration-120 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 data-instant:duration-0',
            className,
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
