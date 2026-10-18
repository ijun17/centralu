import { useMemo, useState } from 'react'
import { THEME_TOKENS, THEME_TOKEN_BY_KEY, type ThemeFileEntry, type ThemeMode } from '@cc/protocol'
import { useStore, usableThemeFiles } from '../../store/store.js'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { SettingsSelect } from './OtherChoice.jsx'
import { isPlainEnter } from '../../app/keys.js'
import { useFollowed } from '../../app/useFollowed.js'
import {
  INK_ORDER,
  READING_SURFACES,
  THEME_PRESETS,
  activeSide,
  isValidTokenValue,
  readPresetTokens,
  resolveColors,
  resolveSide,
  systemPrefersDark,
  unusableValues,
  urgencyBreaks,
  type ThemeBase,
} from '../../app/theme.js'
import { SettingToggle } from './SettingToggle.jsx'
import { Segmented } from '../../components/Segmented.jsx'
import { Button } from '../../components/Button.jsx'
import { Badge } from '../../components/Badge.jsx'
import { TextInput } from '../../components/TextField.jsx'

const MODES: { id: ThemeMode; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Follow system' },
]

/** The accent a person starts from when they first turn it on — a calm blue that reads on both sides */
const DEFAULT_ACCENT = '#6ea8fe'

/**
 * Settings → Appearance → Theme (#312).
 *
 * The choice (mode, a theme per side, the accent) is a preference; a custom theme is a file in
 * the data folder (`themes/<id>.json`), so it can be edited here, in an editor, or by an agent,
 * and every one of those shows up live. This screen only ever writes the file — the host
 * watches the folder and the list comes back through `themes_changed`, the same way a hand edit
 * does.
 */
export function ThemeSection() {
  const platform = usePlatform()
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  const setToast = useStore((s) => s.setToast)
  const themeFiles = useStore((s) => s.themeFiles)
  const lastGood = useStore((s) => s.lastGoodThemes)
  const usable = useMemo(() => usableThemeFiles({ themeFiles, lastGoodThemes: lastGood }), [themeFiles, lastGood])
  const [editing, setEditing] = useState<string | null>(null)
  const fileManager = platform.capabilities.fileManagerName

  const showing = activeSide(prefs.themeMode, systemPrefersDark())
  const sideKey = (side: ThemeBase) => (side === 'dark' ? 'themeDark' : 'themeLight')

  const duplicate = async () => {
    const current = resolveSide(showing, prefs[sideKey(showing)], usable, null)
    const file = usable.find((f) => f.id === current.id)
    // A theme file is copied as written; a preset is read off the stylesheet, every token spelled out
    const tokens = file ? { ...file.tokens } : readPresetTokens(current.preset)
    try {
      const saved = await platform.themes.save(null, { name: `${current.name} copy`, base: current.base, tokens })
      await useStore.getState().refreshThemes()
      await setPrefs({ [sideKey(saved.base)]: saved.id })
      setEditing(saved.id)
    } catch (e) {
      setToast(`Could not create the theme file: ${(e as Error).message}`)
    }
  }

  const importFile = async () => {
    const path = await platform.system.pickFile({ title: 'Import a theme', extensions: ['json'] })
    if (!path) return
    try {
      const saved = await platform.themes.importFile(path)
      await useStore.getState().refreshThemes()
      setToast(`Imported “${saved.name}”`)
    } catch (e) {
      setToast(`Could not import that theme: ${(e as Error).message}`)
    }
  }

  return (
    <section data-testid="settings-theme">
      <p className="text-xs leading-body text-ink-faint">
        Theme. Custom themes are files you can also edit by hand or ask an agent to write; changes show up as soon as the
        file is saved.
      </p>
      <Segmented
        label="Theme mode"
        value={prefs.themeMode}
        onChange={(themeMode) => void setPrefs({ themeMode })}
        size="md"
        className="mt-3 gap-2"
        optionClassName="leading-none"
        options={MODES.map((m) => ({ value: m.id, label: m.label, testId: `settings-theme-mode-${m.id}` }))}
      />

      <div className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm text-ink-muted">
        {(['dark', 'light'] as const).map((side) => (
          <SidePicker key={side} side={side} value={prefs[sideKey(side)]} files={usable} onPick={(id) => void setPrefs({ [sideKey(side)]: id })} />
        ))}
      </div>

      <SettingToggle
        className="mt-3"
        checked={prefs.accent !== null}
        onChange={(on) => setPrefs({ accent: on ? DEFAULT_ACCENT : null })}
        label="Accent colour"
        hint="Colours focus, selection and checked boxes. Never the white of something waiting for you."
        testId="settings-accent-toggle"
      >
        {prefs.accent !== null && (
          <input
            type="color"
            aria-label="Accent colour"
            value={/^#[0-9a-f]{6}$/i.test(prefs.accent) ? prefs.accent : DEFAULT_ACCENT}
            onChange={(e) => void setPrefs({ accent: e.target.value })}
            className="h-5 w-8 cursor-pointer rounded-sm border border-line bg-transparent"
            data-testid="settings-accent-color"
          />
        )}
      </SettingToggle>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="md" onClick={() => void duplicate()} data-testid="settings-theme-duplicate">
          Customise…
        </Button>
        <Button variant="quiet" size="md" onClick={() => void importFile()} data-testid="settings-theme-import">
          Import…
        </Button>
        <span className="text-xs text-ink-faint">Customise copies the theme showing now into a file of your own.</span>
      </div>

      {themeFiles.length > 0 && (
        <ul className="mt-3 divide-y divide-line/60 rounded-md border border-line" data-testid="theme-files">
          {themeFiles.map((file) => (
            <ThemeFileRow
              key={file.id}
              file={file}
              shown={usable.find((f) => f.id === file.id) ?? file}
              fileManager={fileManager}
              open={editing === file.id}
              onToggle={() => setEditing(editing === file.id ? null : file.id)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function SidePicker({
  side,
  value,
  files,
  onPick,
}: {
  side: ThemeBase
  value: string
  files: ThemeFileEntry[]
  onPick: (id: string) => void
}) {
  const presets = THEME_PRESETS.filter((p) => p.base === side)
  const own = files.filter((f) => f.base === side)
  const resolved = resolveSide(side, value, files, null)
  const known = presets.some((p) => p.id === value) || own.some((f) => f.id === value)
  return (
    <>
      <span>{side === 'dark' ? 'Dark theme' : 'Light theme'}</span>
      <SettingsSelect
        tone="raised"
        value={value}
        onChange={(e) => onPick(e.target.value)}
        data-testid={`settings-theme-${side}`}
      >
        {!known && <option value={value}>{`${resolved.name}${resolved.base !== side ? ` (no ${side} theme yet)` : ''}`}</option>}
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {own.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </SettingsSelect>
    </>
  )
}

function ThemeFileRow({
  file,
  shown,
  fileManager,
  open,
  onToggle,
}: {
  /** As the host read it now (may be broken) */
  file: ThemeFileEntry
  /** What the screen applies (the last clean read, while the file is broken) */
  shown: ThemeFileEntry
  fileManager: string
  open: boolean
  onToggle: () => void
}) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  const problems = [...file.problems, ...(file.broken ? [] : unusableValues(file))]
  const breaks = useMemo(() => urgencyOf(shown), [shown])

  const remove = async () => {
    const res = await platform.themes.remove(file.id).catch((e: Error) => ({ supported: true, reason: e.message, failed: true }))
    if (!res.supported || 'failed' in res) {
      setToast(res.reason ?? 'Could not move the theme to the trash')
      return
    }
    // A side that showed this theme goes back to its preset rather than pointing at nothing
    const patch: Record<string, string> = {}
    if (prefs.themeDark === file.id) patch.themeDark = 'dark'
    if (prefs.themeLight === file.id) patch.themeLight = 'light'
    if (Object.keys(patch).length) await setPrefs(patch)
    await useStore.getState().refreshThemes()
  }

  return (
    <li className="px-2.5 py-2" data-testid={`theme-file-${file.id}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-sm text-ink">{shown.name}</span>
        <span className="text-2xs text-ink-faint">{shown.base}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">
          <button type="button" className="text-ink-muted hover:text-ink" onClick={onToggle} data-testid={`theme-edit-${file.id}`}>
            {open ? 'Close' : 'Edit'}
          </button>
          <button
            type="button"
            className="text-ink-muted hover:text-ink"
            onClick={() => void platform.system.openInIde(file.path).catch((e: Error) => setToast(e.message))}
            data-testid={`theme-open-${file.id}`}
          >
            Open file
          </button>
          <button
            type="button"
            className="text-ink-muted hover:text-ink"
            onClick={() =>
              void platform.themes.reveal(file.id).then((r) => {
                if (!r.supported) setToast(r.reason ?? `Could not show it in ${fileManager}`)
              })
            }
            data-testid={`theme-reveal-${file.id}`}
          >
            Show in {fileManager}
          </button>
          <button type="button" className="text-ink-faint hover:text-danger" onClick={() => void remove()} data-testid={`theme-delete-${file.id}`}>
            Delete
          </button>
        </span>
      </div>
      {problems.length > 0 && (
        <ul className="mt-1 text-xs leading-body text-ink-muted" data-testid={`theme-problems-${file.id}`}>
          {file.broken && <li>The file cannot be read as a theme, so the last version that could is still showing.</li>}
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {breaks.length > 0 && (
        <ul className="mt-1 text-xs leading-body text-danger" data-testid={`theme-urgency-${file.id}`}>
          <li>The urgency order breaks: the signal has to stand out most, then text, secondary, background.</li>
          {breaks.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {open && <TokenEditor file={file} />}
    </li>
  )
}

/** The order check for a theme file, resolved the way the page would draw it */
function urgencyOf(file: ThemeFileEntry): string[] {
  if (typeof document === 'undefined') return []
  const tokens: Record<string, string> = {}
  for (const [key, value] of Object.entries(file.tokens)) {
    if (isValidTokenValue(key, value)) tokens[THEME_TOKEN_BY_KEY.get(key)!.cssVar] = value
  }
  const preset = THEME_PRESETS.find((p) => p.base === file.base)?.id ?? THEME_PRESETS[0]!.id
  const names = [...READING_SURFACES.map(([n]) => n), ...INK_ORDER.map(([n]) => n)]
  return urgencyBreaks(resolveColors(tokens, preset, names))
}

function TokenEditor({ file }: { file: ThemeFileEntry }) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  // Follows the file's name when it is changed outside (the file edited by hand), as a token row follows its value
  const [name, setName] = useFollowed(file.name)
  if (file.broken) {
    return <p className="mt-2 text-xs text-ink-faint">Fix the file (Open file) to edit it here.</p>
  }
  const write = async (tokens: Record<string, string>, nextName = file.name) => {
    try {
      await platform.themes.save(file.id, { name: nextName, base: file.base, tokens })
      await useStore.getState().refreshThemes()
    } catch (e) {
      setToast(`Could not save the theme: ${(e as Error).message}`)
    }
  }
  let group = ''
  return (
    <div className="mt-2" data-testid={`theme-editor-${file.id}`}>
      <label className="flex items-center gap-2 text-xs text-ink-muted">
        Name
        <TextInput
          size="sm"
          text="sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== file.name && void write(file.tokens, name.trim())}
          className="min-w-0 flex-1"
          data-testid={`theme-name-${file.id}`}
        />
      </label>
      <p className="mt-2 text-xs leading-body text-ink-faint">
        A value takes any CSS the browser accepts. An empty field falls back to the {file.base} preset.
      </p>
      <div className="mt-1 grid grid-cols-[1fr_auto_minmax(0,14rem)] items-center gap-x-2 gap-y-1">
        {THEME_TOKENS.map((token) => {
          const heading = token.group !== group
          group = token.group
          return [
            heading && (
              <Badge as="p" key={`${token.key}-group`} className="col-span-3 mt-2 tracking-caps">
                {token.group}
              </Badge>
            ),
            <TokenRow
              key={token.key}
              tokenKey={token.key}
              label={token.label}
              kind={token.kind}
              value={file.tokens[token.key] ?? ''}
              onCommit={(value) => {
                const tokens = { ...file.tokens }
                if (value) tokens[token.key] = value
                else delete tokens[token.key]
                void write(tokens)
              }}
            />,
          ]
        })}
      </div>
    </div>
  )
}

function TokenRow({
  tokenKey,
  label,
  kind,
  value,
  onCommit,
}: {
  tokenKey: string
  label: string
  kind: string
  value: string
  onCommit: (value: string) => void
}) {
  // A change from outside (the file edited by hand) replaces the draft
  const [draft, setDraft] = useFollowed(value)
  const valid = draft.trim() === '' || isValidTokenValue(tokenKey, draft.trim())
  const commit = () => {
    const next = draft.trim()
    if (next === value || !valid) return
    onCommit(next)
  }
  const hex = /^#[0-9a-f]{6}$/i.test(draft.trim()) ? draft.trim() : null
  return (
    <>
      <span className="truncate text-xs text-ink-muted" title={tokenKey}>
        {label}
      </span>
      {kind === 'color' ? (
        <input
          type="color"
          aria-label={`${label} colour`}
          value={hex ?? '#000000'}
          onChange={(e) => {
            setDraft(e.target.value)
            onCommit(e.target.value)
          }}
          className={`h-5 w-7 cursor-pointer rounded-sm border border-line bg-transparent ${hex ? '' : 'opacity-40'}`}
          data-testid={`theme-swatch-${tokenKey}`}
        />
      ) : (
        <span />
      )}
      <TextInput
        size="xs"
        font="readout"
        invalid={!valid}
        value={draft}
        placeholder="preset"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (isPlainEnter(e.nativeEvent)) commit()
        }}
        title={valid ? undefined : 'The browser does not accept this value'}
        className="min-w-0"
        data-testid={`theme-token-${tokenKey}`}
      />
    </>
  )
}
