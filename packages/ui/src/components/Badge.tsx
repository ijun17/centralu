import type { HTMLAttributes, ReactNode } from 'react'

/**
 * The small uppercase label: a section's name inside a card or a list (MODELS, RUNS, PREVIOUS), or a kind written
 * beside a row. 10px capitals in the faint ink, so it orders what is below it without competing with it.
 *
 * Twenty places wrote `text-2xs uppercase text-ink-faint` by hand. Two kinds are in use and both stay:
 *
 * - `readout` (most of them): the figures' font (`.readout`, the code font with even digits), for a label that sits
 *   among values, versions and counts.
 * - without it: the body font, for a label that heads prose or a list of names.
 *
 * `tone="ink"` lifts it to the plain ink when what it names needs the eye (an app review's alert). `as` keeps the
 * element the label is in its document: a heading where it heads a section, a `p` or a `span` elsewhere. `className`
 * is placement only, as with Button.
 */
export function Badge({
  as: Tag = 'span',
  readout = false,
  tone = 'faint',
  className = '',
  children,
  ...rest
}: {
  as?: 'span' | 'p' | 'div' | 'h2' | 'h3' | 'h4' | 'dt' | 'th' | 'legend'
  readout?: boolean
  tone?: 'faint' | 'muted' | 'ink'
  className?: string
  children: ReactNode
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'>) {
  const ink = tone === 'ink' ? 'text-ink' : tone === 'muted' ? 'text-ink-muted' : 'text-ink-faint'
  return (
    <Tag className={`${readout ? 'readout ' : ''}text-2xs uppercase ${ink} ${className}`.trim()} {...rest}>
      {children}
    </Tag>
  )
}
