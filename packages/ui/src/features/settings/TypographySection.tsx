import { TEXT_SIZES, type LineHeight } from '@cc/protocol/client'
import { useStore } from '../../store/store.js'
import { BODY_FONTS, CODE_FONTS, isUsableFont } from '../../app/typography.js'
import { OtherInput, OtherOption, SettingsSelect, useOtherChoice } from './OtherChoice.jsx'
import { Segmented } from '../../components/Segmented.jsx'
import { textInputClass } from '../../components/TextField.jsx'
import { More, SettingsGroup, SettingsRow } from './SettingsLayout.jsx'

const LINE_HEIGHTS: { id: LineHeight; label: string }[] = [
  { id: 'compact', label: 'Compact' },
  { id: 'normal', label: 'Normal' },
  { id: 'relaxed', label: 'Relaxed' },
]

/**
 * Text in Appearance (#312 step 5): the app-wide text size, the body and code fonts, and the line
 * height. Each applies as soon as it is picked (App.tsx writes it on the root) and is kept in the
 * preferences with the theme.
 */
export function TypographySection() {
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  return (
    <SettingsGroup
      testId="settings-typography"
      title="Text"
      hint={
        <>
          The app’s own fonts stay behind the one you pick, so a font that is not installed, or one without Korean, falls
          back to them.
          <More>Line height applies to replies and code blocks; the code viewer and diffs keep their fixed rows.</More>
        </>
      }
    >
      <TextSize value={prefs.textSize} onPick={(textSize) => void setPrefs({ textSize })} />
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
      <SettingsRow
        label="Line height"
        control={
          <Segmented
            label="Line height"
            value={prefs.lineHeight}
            onChange={(lineHeight) => void setPrefs({ lineHeight })}
            size="sm"
            options={LINE_HEIGHTS.map((l) => ({ value: l.id, label: l.label, testId: `settings-line-height-${l.id}` }))}
          />
        }
      />
    </SettingsGroup>
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
    <SettingsRow
      label="Text size"
      hint="For the whole app, applied at once."
      control={
        <div className="flex items-end gap-1.5" role="radiogroup" aria-label="Text size">
          {TEXT_SIZES.map((factor, i) => (
            <button
              key={factor}
              type="button"
              role="radio"
              aria-checked={factor === value}
              data-testid={`settings-scale-${i}`}
              onClick={() => onPick(factor)}
              className={`rounded-md border px-2 py-1 leading-none transition-colors ${
                factor === value
                  ? 'border-ink-muted bg-surface-hover/40 text-ink'
                  : 'border-line text-ink-muted hover:border-line-strong hover:text-ink'
              }`}
              title={factor === 1 ? 'Default' : `${Math.round(factor * 100)}%`}
            >
              <span style={{ fontSize: `calc(var(--text-md) * ${factor} / var(--text-zoom))` }}>가Aa</span>
            </button>
          ))}
        </div>
      }
    />
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
  const choice = useOtherChoice({ other: !listed, draft: listed ? '' : value })
  const usable = isUsableFont(choice.draft)

  const commit = () => {
    const font = choice.draft.trim()
    if (!isUsableFont(font) || font === value) return
    onPick(font)
  }

  return (
    <SettingsRow
      label={label}
      hint={
        <span className={`block truncate text-sm text-ink-muted ${kind === 'body' ? 'font-sans' : 'font-mono'}`} data-testid={`settings-font-${kind}-sample`}>
          {sample}
        </span>
      }
      control={
        <>
          {choice.other && (
            <OtherInput
              draft={choice.draft}
              onDraft={choice.setDraft}
              commit={commit}
              autoFocus={choice.asked}
              placeholder={kind === 'body' ? 'Font name, e.g. Inter' : 'Font name, e.g. Iosevka'}
              aria-label={`${label} name`}
              aria-invalid={!usable}
              className={`w-40 ${textInputClass({ size: 'sm', text: 'sm', invalid: !usable })}`}
              data-testid={`settings-font-${kind}-other`}
            />
          )}
          <SettingsSelect
            tone="compact"
            className="w-44"
            aria-label={label}
            value={choice.shown(value)}
            onChange={(e) => choice.onSelect(e, value, onPick)}
            data-testid={`settings-font-${kind}`}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            <OtherOption />
          </SettingsSelect>
        </>
      }
    />
  )
}
