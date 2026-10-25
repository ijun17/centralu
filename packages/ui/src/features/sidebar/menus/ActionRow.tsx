import type { ReactNode } from 'react'

/** One menu row. Closing is bundled into onClick — the caller that opens it is the one that knows onClose */
export function ActionRow({
  label,
  onClick,
  testId,
  danger,
  disabled,
  pending,
  title,
  trailing,
  describedBy,
}: {
  label: string
  onClick: () => void
  testId: string
  danger?: boolean
  /** Shown but not pressable, with `title` saying why (a linked machine that is not connected, #734) */
  disabled?: boolean
  /**
   * The row's action is under way (#1533): it reads as disabled and presses nothing, but stays focusable, so a keyboard
   * user who pressed it does not lose their place in the menu when the button would have been disabled under their focus
   */
  pending?: boolean
  title?: string
  /** A mark at the row's right end (a machine's link state, #734) */
  trailing?: ReactNode
  /** The id of text that says more about the row, read with it (#1533: why the last attempt failed) */
  describedBy?: string
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={pending ? undefined : onClick}
      disabled={disabled}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      title={title}
      aria-describedby={describedBy}
      className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-hover/60 disabled:opacity-50 disabled:hover:bg-transparent aria-disabled:opacity-50 aria-disabled:hover:bg-transparent ${
        danger ? 'text-ink-muted hover:text-ink-signal' : 'text-ink-muted hover:text-ink'
      } ${trailing ? 'flex items-center justify-between gap-2' : ''}`}
    >
      {trailing ? <span className="truncate">{label}</span> : label}
      {trailing}
    </button>
  )
}
