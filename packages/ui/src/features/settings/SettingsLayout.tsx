import { useState, type HTMLAttributes, type ReactNode } from 'react'
import { ChevronIcon } from '../../components/icons.jsx'

/**
 * The parts every Settings category is laid out with, so the pages read as one window (owner, 2026-10-19).
 *
 * - `SettingsPage`: the category's name and one short line under it.
 * - `SettingsGroup`: a card of rows split by hairlines, with an optional small heading above it.
 * - `SettingsRow`: a label (and a short hint under it) on the left, its control on the right, centred.
 * - `SettingsDisclosure`: settings most people never need, folded under one heading ("Advanced") until opened.
 * - `More`: the rest of an explanation, one press away. It stays in the page while closed (`hidden`), so what a row
 *   says for safety is still there for a screen reader's search and for a test that reads the section's text; it is
 *   only out of the way.
 */
export function SettingsPage({
  title,
  lead,
  children,
  testId,
}: {
  title: string
  lead?: ReactNode
  children: ReactNode
  testId?: string
}) {
  return (
    <section data-testid={testId}>
      <header className="mb-5">
        <h3 className="text-display font-medium leading-tight text-ink">{title}</h3>
        {lead && <p className="mt-1 text-sm leading-body text-ink-faint">{lead}</p>}
      </header>
      <div className="space-y-6">{children}</div>
    </section>
  )
}

export function SettingsGroup({
  title,
  hint,
  action,
  children,
  testId,
  className = '',
}: {
  title?: ReactNode
  hint?: ReactNode
  /** A control beside the heading (Reset to defaults, Delete all archived sessions…) */
  action?: ReactNode
  children: ReactNode
  testId?: string
  className?: string
}) {
  return (
    <div className={className} data-testid={testId}>
      {(title || action) && (
        <div className="mb-2 flex items-end gap-3 px-1">
          <div className="min-w-0 flex-1">
            {title && <h4 className="text-xs font-medium text-ink-muted">{title}</h4>}
            {hint && <div className="mt-0.5 text-xs leading-body text-ink-faint">{hint}</div>}
          </div>
          {action}
        </div>
      )}
      <SettingsCard>{children}</SettingsCard>
    </div>
  )
}

/** The card alone: rows split by hairlines, for a list that brings its own heading. `as="li"` for a card in a list */
export function SettingsCard({
  as: Tag = 'div',
  children,
  className = '',
  testId,
  ...rest
}: {
  as?: 'div' | 'li' | 'ul'
  children: ReactNode
  className?: string
  testId?: string
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'>) {
  return (
    <Tag className={`divide-y divide-line/70 rounded-lg border border-line bg-surface-raised ${className}`.trim()} data-testid={testId} {...rest}>
      {children}
    </Tag>
  )
}

/** A quiet line inside a card, where its list is empty */
export function SettingsEmpty({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="px-4 py-3 text-sm text-ink-faint" data-testid={testId}>
      {children}
    </p>
  )
}

export function SettingsRow({
  label,
  hint,
  more,
  control,
  children,
  testId,
  className = '',
}: {
  label: ReactNode
  hint?: ReactNode
  /** The rest of the explanation, behind `More`; opened, it runs the row's full width under the control */
  more?: ReactNode
  control?: ReactNode
  /** What follows the row under it (a confirmation, a list the switch turns on) */
  children?: ReactNode
  testId?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`px-4 py-3 ${className}`.trim()} data-testid={testId}>
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-ink">{label}</div>
          {(hint || more) && (
            <div className="mt-0.5 text-xs leading-body text-ink-faint">
              {hint}
              {more && <MoreButton open={open} onToggle={() => setOpen((v) => !v)} />}
            </div>
          )}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {more && <MoreText open={open}>{more}</MoreText>}
      {children}
    </div>
  )
}

/**
 * A folded section of a page (owner, 2026-10-20: the Orchestrator's agent limits and models, under "Advanced"). Closed,
 * only its heading is drawn and nothing under it is built: a control present but unseen is one a test can pass on and
 * a screen reader can walk into (Settings.tsx). Opening it is not remembered; the page opens folded each time.
 */
export function SettingsDisclosure({
  title,
  hint,
  children,
  testId,
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div data-testid={testId}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group/disclosure flex w-full items-center gap-1.5 px-1 text-left"
        data-testid={testId && `${testId}-toggle`}
      >
        <span className="text-ink-faint transition-colors group-hover/disclosure:text-ink-muted">
          <ChevronIcon open={open} />
        </span>
        <span className="text-xs font-medium text-ink-muted transition-colors group-hover/disclosure:text-ink">{title}</span>
        {hint && !open && <span className="min-w-0 truncate text-xs text-ink-faint">{hint}</span>}
      </button>
      {open && <div className="mt-3 space-y-6">{children}</div>}
    </div>
  )
}

/** "More": the rest of a hint, opened in place. Kept in the page while closed, see the file's note */
export function More({ children, label = 'More' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <MoreButton open={open} label={label} onToggle={() => setOpen((v) => !v)} />
      <MoreText open={open}>{children}</MoreText>
    </>
  )
}

function MoreButton({ open, label = 'More', onToggle }: { open: boolean; label?: string; onToggle: () => void }) {
  return (
    <>
      {' '}
      <button
        type="button"
        aria-expanded={open}
        className="text-ink-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink"
        onClick={onToggle}
      >
        {open ? 'Less' : label}
      </button>
    </>
  )
}

function MoreText({ open, children }: { open: boolean; children: ReactNode }) {
  return <span className={`mt-1.5 text-xs leading-body text-ink-faint ${open ? 'block' : 'hidden'}`}>{children}</span>
}
