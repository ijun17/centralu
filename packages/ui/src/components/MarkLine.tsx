import { useId, useState, type ReactNode } from 'react'
import { ChevronIcon } from './icons.jsx'
import { Fold } from './Fold.jsx'
import { Pill } from './Pill.jsx'

const Rule = () => <span className="h-px flex-1 bg-line" />
/** A long line wraps before the rules are gone, so it still reads as a line between messages, not a box of text */
const WIDE = 'max-w-[34rem]'

/**
 * A line of the conversation that is not a message: a capsule between two rules, or a dashed box for a failure
 * (docs/design-system.md §7). With `folded`, the capsule is a button that opens it as a `Fold`; `open` is how it
 * starts, `onOpen` hears each opening (the mail line reads what it shows then), `after` stands beside the capsule.
 */
export function MarkLine({
  icon,
  failed,
  children,
  folded,
  open: startOpen = false,
  onOpen,
  after,
  ...data
}: {
  icon: ReactNode
  failed?: boolean
  children: ReactNode
  folded?: ReactNode
  open?: boolean
  onOpen?: () => void
  after?: ReactNode
} & Record<`data-${string}`, string>) {
  const [open, setOpen] = useState(startOpen)
  const id = useId()
  const words = (
    <>
      {folded && <ChevronIcon open={open} size={10} />}
      {icon}
      <span className="min-w-0">{children}</span>
    </>
  )
  return (
    <div className="py-1" data-testid="msg-mark" {...data}>
      <div className="flex items-center gap-2">
        <Rule />
        {failed ? (
          <span className={`${WIDE} inline-flex min-w-0 items-center gap-1.5 break-words rounded-field border border-dashed border-line-strong px-2.5 py-0.5 text-2xs text-ink-muted`}>
            {words}
          </span>
        ) : (
          <Pill
            size="line"
            tone="faint"
            className={WIDE}
            {...(folded ? { onClick: () => {
                  if (!open) onOpen?.()
                  setOpen(!open)
                }, 'aria-expanded': open, 'aria-controls': id, 'data-testid': 'mark-toggle' } : {})}
          >
            {words}
          </Pill>
        )}
        {after}
        <Rule />
      </div>
      {folded && (
        <Fold open={open} testId="mark-folded">
          <div id={id}>{folded}</div>
        </Fold>
      )}
    </div>
  )
}
