import { useState, type ReactNode } from 'react'

/**
 * One switch of Settings (#850 item 12): a checkbox, its label, and a line saying what it does.
 *
 * About a dozen rows wrote this by hand, and only some guarded a change still saving: the background switch took a
 * second click while the keeper had not answered the first, so the two changes raced. Here a change that returns a
 * promise disables the box until it settles, for every switch.
 *
 * - `hint` goes under the row, or inside the label beside the box with `hintInside` (a longer explanation that reads
 *   as part of the choice).
 * - `children` follow the label inside it (a control the switch turns on, such as the accent colour).
 * - `className` places the row (its margin); the rest of its look is this component's.
 */
export function SettingToggle({
  checked,
  onChange,
  label,
  hint,
  hintInside = false,
  disabled = false,
  testId,
  className = '',
  children,
}: {
  checked: boolean
  onChange: (on: boolean) => void | Promise<unknown>
  label: ReactNode
  hint?: ReactNode
  hintInside?: boolean
  disabled?: boolean
  testId?: string
  className?: string
  children?: ReactNode
}) {
  const [saving, setSaving] = useState(false)
  const change = (on: boolean) => {
    const pending = onChange(on)
    if (!pending) return
    setSaving(true)
    void Promise.resolve(pending)
      .catch(() => {})
      .finally(() => setSaving(false))
  }
  const box = (
    <input
      type="checkbox"
      className={hintInside ? 'mt-0.5 accent-line-strong' : 'accent-line-strong'}
      data-testid={testId}
      checked={checked}
      disabled={disabled || saving}
      onChange={(e) => change(e.target.checked)}
    />
  )
  if (hintInside) {
    return (
      <label className={`${className} flex items-start gap-2 text-sm text-ink-muted`.trim()}>
        {box}
        <span>
          {label}
          {hint && <span className="mt-1 block text-xs leading-body text-ink-faint">{hint}</span>}
        </span>
        {children}
      </label>
    )
  }
  return (
    <>
      <label className={`${className} flex items-center gap-2 text-sm text-ink-muted`.trim()}>
        {box}
        {label}
        {children}
      </label>
      {hint && <p className="mt-1 text-xs leading-body text-ink-faint">{hint}</p>}
    </>
  )
}
