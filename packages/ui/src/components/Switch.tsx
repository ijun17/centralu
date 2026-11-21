import type { InputHTMLAttributes } from 'react'

/**
 * An on/off switch (docs/design-system.md §11). A transparent `<input type="checkbox">` lies over the drawn track, so a
 * click, Space, a screen reader and a test all reach the checkbox; the look follows it through `peer-*`. On is the muted
 * ink, never the signal: a switch is not waiting on the person. Every prop goes to the input; `className` places it.
 */
export function Switch({ className = '', ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return (
    <span className={`cc-switch relative inline-flex h-4 w-7 shrink-0 ${className}`.trim()}>
      <input
        {...input}
        type="checkbox"
        className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
      />
      <span
        aria-hidden
        className="cc-switch-track size-full rounded-full border border-line-strong bg-surface-hover/60 transition-colors peer-checked:border-ink-muted peer-checked:bg-ink-muted peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-focus peer-disabled:opacity-50"
      />
      <span
        aria-hidden
        className="cc-switch-knob pointer-events-none absolute left-0.5 top-0.5 size-3 rounded-full bg-ink-muted transition-transform duration-150 peer-checked:translate-x-3 peer-checked:bg-surface-floor peer-disabled:opacity-50"
      />
    </span>
  )
}
