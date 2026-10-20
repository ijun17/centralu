import { useState, type ChangeEvent, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react'
import { isPlainEnter } from '../../app/keys.js'

/**
 * The selects of the settings, in the two shapes they come in: `compact` (on the floor, a row's
 * quiet value: the idle-sleep time, a model) and `raised` (a value on its own line: a theme, a font).
 * `className` adds what is specific to one place, such as a width.
 */
const SELECT_TONE = {
  compact: 'rounded-md border border-line bg-surface-floor px-1.5 py-0.5 text-sm text-ink',
  raised: 'w-fit rounded-md border border-line bg-surface-raised px-2 py-1 text-sm text-ink',
} as const

export function SettingsSelect({
  tone,
  className,
  ...props
}: { tone: keyof typeof SELECT_TONE } & SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={className ? `${SELECT_TONE[tone]} ${className}` : SELECT_TONE[tone]} />
}

/** The value of the "Other…" option: no listed choice can be it */
const OTHER = '\u0000other'

/** The last option of a select whose list is not all there is: the person types the rest */
export function OtherOption() {
  return <option value={OTHER}>Other…</option>
}

/**
 * The state of a select with an "Other…" choice that opens a text field: whether the field is open
 * and what is typed in it.
 *
 * `asked` says the field was opened by choosing "Other…", as against starting open because the
 * current value is not listed. Only a field the person just asked for takes the keyboard: one that
 * is open from the start must not pull focus when the settings open.
 */
export function useOtherChoice(initial: { other: boolean; draft: string }) {
  const [other, setOther] = useState(initial.other)
  const [draft, setDraft] = useState(initial.draft)
  const [asked, setAsked] = useState(false)
  return {
    other,
    draft,
    setDraft,
    asked,
    /** What the select shows: "Other…" while the field is open, else the current `value` */
    shown: (value: string) => (other ? OTHER : value),
    /**
     * The select's `onChange`: "Other…" opens the field with `seed` typed in; any listed choice
     * closes it and goes to `pick`.
     */
    onSelect: (e: ChangeEvent<HTMLSelectElement>, seed: string, pick: (value: string) => void) => {
      if (e.target.value === OTHER) {
        setOther(true)
        setAsked(true)
        setDraft(seed)
        return
      }
      setOther(false)
      pick(e.target.value)
    },
    /** Back to the select as it was */
    close: () => setOther(false),
  }
}

/**
 * The text field behind "Other…". It commits on blur and on Enter, but not on the Enter that ends
 * an input-method composition (#181): a Korean name's last syllable is still being composed then.
 */
export function OtherInput({
  draft,
  onDraft,
  commit,
  ...props
}: {
  draft: string
  onDraft: (draft: string) => void
  commit: () => void
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown' | 'type'>) {
  return (
    <input
      {...props}
      type="text"
      value={draft}
      spellCheck={false}
      maxLength={200}
      onChange={(e) => onDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isPlainEnter(e.nativeEvent)) commit()
      }}
    />
  )
}
