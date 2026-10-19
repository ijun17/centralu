import type { InputHTMLAttributes } from 'react'

/**
 * An on/off switch: a small track with a knob, for a setting that is simply on or off (Settings' rows).
 *
 * It stays a checkbox underneath. The real `<input type="checkbox">` lies over the drawn track, transparent, so a
 * click, the keyboard (Space), a screen reader and a test (`check()`, `checked`) all reach the same element they
 * reached when it was a bare box; only the look changed. The knob and the track follow the input through `peer-*`.
 *
 * On, the track takes the muted ink and the knob the floor, the way a checked box filled itself (index.css); with the
 * person's accent on, the accent (`.cc-switch` in index.css), as checked boxes do. Never the signal white: a switch
 * is not something waiting on the person.
 *
 * Every prop goes to the input (`checked`, `onChange`, `disabled`, `data-testid`, `aria-label`, `id`); `className`
 * places the switch.
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
