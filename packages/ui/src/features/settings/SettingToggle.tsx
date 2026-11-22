import { useId, useState, type ReactNode } from 'react'
import { Switch } from '../../components/Switch.jsx'
import { SettingsRow } from './SettingsLayout.jsx'

/**
 * One Settings switch (#850 item 12): a card row, label and hint on the left, switch on the right. A change returning
 * a promise disables it until settled, or a second click would race the keeper's answer. A checkbox underneath
 * (`Switch`) with `testId` on the input. `more` is the rest of a long hint behind "More"; `children` stand beside the switch;
 * `className` only places the row.
 */
export function SettingToggle({
  checked,
  onChange,
  label,
  hint,
  more,
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
