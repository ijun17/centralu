import { useState, type ChangeEvent, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react'
import { isPlainEnter } from '../../app/keys.js'
import { ChevronIcon } from '../../components/icons.jsx'

/**
 * The settings' selects: `compact` (a row's quiet value: sleep time, a model) or `raised` (a value on its own line: a
 * theme, a font); `className` goes on the frame (a width). Drawn, not the OS's: the native arrow and fill differ per
 * engine and look dropped in. The select underneath is native (props, test id, list); only the face and chevron are ours.
 */
const SELECT_TONE = {
  compact: 'bg-surface-floor',
  raised: 'bg-surface-raised',
} as const

export function SettingsSelect({
  tone,
  className,
  ...props
}: { tone: keyof typeof SELECT_TONE } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex min-w-0 ${className ?? ''}`.trim()}>
      <select
        {...props}
        className={`w-full min-w-0 cursor-pointer appearance-none truncate rounded-md border border-line py-1 pl-2 pr-6 text-sm text-ink transition-colors hover:border-line-strong focus:border-line-strong focus:outline-none disabled:cursor-default disabled:opacity-50 ${SELECT_TONE[tone]}`}
      />
      <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-faint">
        <ChevronIcon open size={11} />
      </span>
    </span>
  )
}

/** The value of the "Other…" option: no listed choice can be it */
const OTHER = '\u0000other'

/** The last option of a select whose list is not all there is: the person types the rest */
export function OtherOption() {
  return <option value={OTHER}>Other…</option>
}

/**
 * The state of a select whose "Other…" opens a text field. `asked`: opened by choosing "Other…", not open from the
 * start for an unlisted value; only an asked field takes the keyboard, so opening Settings pulls no focus.
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
