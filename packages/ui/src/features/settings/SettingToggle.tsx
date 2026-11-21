import { useId, useState, type ReactNode } from 'react'
import { Switch } from '../../components/Switch.jsx'
import { SettingsRow } from './SettingsLayout.jsx'

/**
 * One switch of Settings (#850 item 12): a row of a settings card, its label and a short line saying what it does on
 * the left, the switch on the right.
 *
 * A second click while the keeper has not answered the first makes the two changes race, so a change that returns a
 * promise disables the switch until it settles, for every switch.
 *
 * The switch is a checkbox underneath (`Switch`): `testId` is on the input itself, so `checked`, `check()` and a
 * click reach it, and the label names it.
 *
 * - `hint` goes under the label; `more` is the rest of a longer explanation, behind "More" (still in the page).
 *   `hintInside` changes nothing in the layout: every hint sits under its label.
 * - `children` stand beside the switch (a control the switch turns on).
 * - `className` places the row; the rest of its look is this component's.
 */
export function SettingToggle({
  checked,
  onChange,
  label,
  hint,
  more,
  hintInside: _hintInside = false,
  disabled = false,
  testId,
  className = '',
  children,
}: {
  checked: boolean
  onChange: (on: boolean) => void | Promise<unknown>
  label: ReactNode
  hint?: ReactNode
  more?: ReactNode
  hintInside?: boolean
  disabled?: boolean
  testId?: string
  className?: string
  children?: ReactNode
}) {
  const id = useId()
  const [saving, setSaving] = useState(false)
  const change = (on: boolean) => {
    const pending = onChange(on)
    if (!pending) return
    setSaving(true)
    void Promise.resolve(pending)
      .catch(() => {})
      .finally(() => setSaving(false))
  }
  return (
    <SettingsRow
      className={className}
      label={
        <label htmlFor={id} className="cursor-pointer">
          {label}
        </label>
      }
      hint={hint}
      more={more}
      control={
        <>
          {children}
          <Switch id={id} data-testid={testId} checked={checked} disabled={disabled || saving} onChange={(e) => change(e.target.checked)} />
        </>
      }
    />
  )
}
