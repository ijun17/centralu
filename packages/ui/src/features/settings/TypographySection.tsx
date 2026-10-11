import { useState } from 'react'
import { TEXT_SIZES, type LineHeight } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { BODY_FONTS, CODE_FONTS, isUsableFont } from '../../app/typography.js'
import { isPlainEnter } from '../../app/keys.js'

const LINE_HEIGHTS: { id: LineHeight; label: string }[] = [
  { id: 'compact', label: 'Compact' },
  { id: 'normal', label: 'Normal' },
  { id: 'relaxed', label: 'Relaxed' },
]

const OTHER = '\u0000other'

/**
 * Text in Appearance (#312 step 5): the app-wide text size, the body and code fonts, and the line
 * height. Each applies as soon as it is picked (App.tsx writes it on the root) and is kept in the
 * preferences with the theme.
 */
export function TypographySection() {
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  return (
    <section className="mt-6 border-t border-line pt-4" data-testid="settings-typography">
      <TextSize value={prefs.textSize} onPick={(textSize) => void setPrefs({ textSize })} />

      <div className="mt-5 grid grid-cols-[auto_1fr] items-start gap-x-3 gap-y-3 text-sm text-ink-muted">
        <FontPicker
          kind="body"
          label="Body font"
          options={BODY_FONTS}
          value={prefs.bodyFont}
          sample="The quick brown fox · 다람쥐 헌 쳇바퀴에 타고파"
          onPick={(bodyFont) => void setPrefs({ bodyFont })}
        />
        <FontPicker
          kind="code"
          label="Code font"
          options={CODE_FONTS}
          value={prefs.codeFont}
          sample="git commit -m 'fix' 0O 1lI {}"
          onPick={(codeFont) => void setPrefs({ codeFont })}
        />
        <span className="py-1">Line height</span>
        <div className="flex gap-2" role="radiogroup" aria-label="Line height">
          {LINE_HEIGHTS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={prefs.lineHeight === l.id}
              data-testid={`settings-line-height-${l.id}`}
              onClick={() => void setPrefs({ lineHeight: l.id })}
              className={`rounded-md border px-2.5 py-1 text-sm leading-none transition-colors ${
                prefs.lineHeight === l.id
                  ? 'border-ink-muted bg-surface-hover/40 text-ink'
                  : 'border-line text-ink-muted hover:bg-surface-hover/25 hover:text-ink'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs leading-body text-ink-faint">
        The app’s own fonts stay behind the one you pick, so a font that is not installed, or one without Korean, falls
        back to them. Line height applies to replies and code blocks; the code viewer and diffs keep their fixed rows.
      </p>
    </section>
  )
}

/**
 * The app-wide text size — five steps, with the middle one as the default.
 *
 * The preview is the label: each button's "가Aa" is rendered at that step's own size, so the
 * result is known before it is clicked. That is why a number (85%…) is not written separately —
 * a ratio can be read, but size has to be seen to be understood. The size is the body size times
 * the step, divided by the zoom already on, so each button shows its real size whichever step is
 * on now.
 */
function TextSize({ value, onPick }: { value: number; onPick: (size: number) => void }) {
  return (
    <>
      <p className="text-xs leading-body text-ink-faint">Text size for the whole app.</p>
      <div className="mt-3 flex items-end gap-2" role="radiogroup" aria-label="Text size">
        {TEXT_SIZES.map((factor, i) => (
          <button
            key={factor}
            type="button"
            role="radio"
            aria-checked={factor === value}
            data-testid={`settings-scale-${i}`}
            onClick={() => onPick(factor)}
            className={`rounded-md border px-2.5 py-1 leading-none transition-colors ${
              factor === value
                ? 'border-ink-muted bg-surface-hover/40 text-ink'
                : 'border-line text-ink-muted hover:bg-surface-hover/25 hover:text-ink'
            }`}
            title={factor === 1 ? 'Default' : `${Math.round(factor * 100)}%`}
          >
            <span style={{ fontSize: `calc(var(--text-md) * ${factor} / var(--text-zoom))` }}>가Aa</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-faint">Applies immediately and is remembered.</p>
    </>
  )
}

/**
 * A short list, plus "Other…" for any installed font by name. What is typed is checked by the
 * browser before it is kept (a value CSS refuses is marked and not saved), and the sample under
 * the field is drawn with the token itself, so it shows what the screen is using now.
 */
function FontPicker({
  kind,
  label,
  options,
  value,
  sample,
  onPick,
}: {
  kind: 'body' | 'code'
  label: string
  options: readonly { value: string; label: string }[]
  value: string
  sample: string
  onPick: (font: string) => void
}) {
  const listed = options.some((o) => o.value === value)
  const [other, setOther] = useState(!listed)
  const [draft, setDraft] = useState(listed ? '' : value)
  const usable = isUsableFont(draft)

  const commit = () => {
    const font = draft.trim()
    if (!isUsableFont(font) || font === value) return
    onPick(font)
  }

  return (
    <>
      <span className="py-1">{label}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={other ? OTHER : value}
            onChange={(e) => {
              if (e.target.value === OTHER) {
                setOther(true)
                setDraft(value)
                return
              }
              setOther(false)
              onPick(e.target.value)
            }}
            className="w-fit rounded-md border border-line bg-surface-raised px-2 py-1 text-sm text-ink"
            data-testid={`settings-font-${kind}`}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
          {other && (
            <input
              type="text"
              value={draft}
              spellCheck={false}
              placeholder={kind === 'body' ? 'Font name, e.g. Inter' : 'Font name, e.g. Iosevka'}
              aria-label={`${label} name`}
              aria-invalid={!usable}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                // A Korean font name's last syllable is still being composed on that Enter (#181)
                if (isPlainEnter(e.nativeEvent)) commit()
              }}
              className={`w-56 rounded-md border bg-surface-raised px-2 py-1 text-sm text-ink placeholder:text-ink-faint focus:outline-none ${
                usable ? 'border-line focus:border-line-strong' : 'border-danger'
              }`}
              data-testid={`settings-font-${kind}-other`}
            />
          )}
        </div>
        <p className={`mt-1.5 truncate text-sm text-ink ${kind === 'body' ? 'font-sans' : 'font-mono'}`} data-testid={`settings-font-${kind}-sample`}>
          {sample}
        </p>
      </div>
    </>
  )
}
