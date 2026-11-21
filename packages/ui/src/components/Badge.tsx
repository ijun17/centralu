import type { HTMLAttributes, ReactNode } from 'react'

/**
 * The small uppercase label: a section's name in a card or a list (MODELS, RUNS), or a kind beside a row; faint, so it
 * orders what is below without competing. `readout` for a label among values and counts (the figures' font), without
 * it for one that heads prose or names. `tone="ink"` when what it names needs the eye (an app review's alert). `as`
 * keeps the document's element (a heading where it heads a section). `className` is placement only, as with Button.
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
