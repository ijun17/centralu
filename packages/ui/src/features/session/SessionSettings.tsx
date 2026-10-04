import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronIcon } from '../../components/icons.jsx'
import type { ModelOption, PermissionPreset, ToolName } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

/**
 * The settings menu below the composer — model, reasoning effort, permissions, agent (FR-7).
 * Can be changed even after a conversation has started — that turns out to be more useful than
 * deciding it all up front.
 *
 * **The four selectors are not lined up side by side.** They used to be a row of `<select>`
 * elements, but all four are things nobody looks at most of the time, so they permanently took
 * up a whole row below the composer, and in a narrow pane like the grid the four pushed against
 * each other and cut off the text. Now the current values read as a single button, and the menu
 * only opens to change them (the same approach as Claude Code).
 *
 * **The model list is never hardcoded here.** It shows exactly what the tool's official API
 * reports (Claude's `supportedModels()`, Codex's `model/list`).
 * This used to be hardcoded, which is why there was no way to pick Fable when it launched — this
 * avoids repeating the situation where the tool has moved on and only this app is stuck.
 */

/*
 * Hints have to be short. 'Asks only for risky actions' (27 characters) used up all the label
 * space in the w-56 menu, so **the word "Normal" itself disappeared** (found in dogfooding) —
 * once the description erases the name, that row cannot be picked.
 */
const PRESETS: { value: PermissionPreset; label: string; hint: string }[] = [
  { value: 'safe', label: 'Safe', hint: 'Asks for everything' },
  { value: 'normal', label: 'Normal', hint: 'Asks when risky' },
  { value: 'auto', label: 'Auto', hint: 'Never asks' },
]

/**
 * The model list per tool. Spawning the tool every time the selector opens would make that
 * click slow, so the host caches it, and this only asks once, when the tool changes.
 */
export function useModels(tool: ToolName, live: boolean): { models: ModelOption[]; reason?: string } {
  const platform = usePlatform()
  const [state, setState] = useState<{ models: ModelOption[]; reason?: string }>({ models: [] })

  /*
   * Why `live` is a dependency:
   *
   * The Claude SDK only exposes the model list through a Query. So **it cannot be read without
   * a running session**. If the app is opened and a sleeping session is selected, there is no
   * query at that moment, so the list comes back empty, and since an empty result was never
   * re-fetched, the selector was permanently left with only "Default" (found in dogfooding).
   * This re-fetches the moment the session wakes up.
   */
  useEffect(() => {
    let alive = true
    /*
     * **Clears the list first** (dogfooding on 2026-09-09: "this is a Claude session, but Codex
     * models are showing").
     *
     * The list is the tool's own vocabulary — 'sonnet' and 'gpt-5.6-sol' are words in each
     * other's dictionary that do not exist, so showing another tool's list even briefly offers
     * something the screen cannot actually pick. This used to leave **the previous tool's list
     * sitting there** until a new response came back: switching from viewing a Codex session to
     * opening a Claude session's menu could still show Codex models for a moment, and because
     * Claude only returns its list once a session is alive (while it is waking up), that window
     * could stretch for whole seconds.
     */
    setState({ models: [] })
    void platform.agents
      .models(tool)
      .then((r) => alive && setState({ models: r.models, reason: r.supported ? undefined : r.reason }))
      // The session must stay usable even if the list cannot be read — this falls back to the
      // default and only keeps the reason
      .catch((e: Error) => alive && setState({ models: [], reason: e.message }))
    return () => {
      alive = false
    }
  }, [platform, tool, live])

  return state
}

/**
 * The response-length levels for this tool (#54). If empty, the tool has no such knob, so the
 * row itself does not appear.
 *
 * This does not branch on the tool's name — it reads the adapter's declared capabilities
 * (verbosities). It is a knob only Codex has today, but writing "show this if codex" would turn
 * it into code that only someone who remembers this file could fix the day Claude gets the same
 * knob.
 */
export function useVerbosities(tool: ToolName): string[] {
  const platform = usePlatform()
  const [levels, setLevels] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void platform.agents
      .capabilities(tool)
      .then((c) => alive && setLevels(c.verbosities))
      // The menu must still render even if capabilities cannot be read — it just loses one row
      .catch(() => alive && setLevels([]))
    return () => {
      alive = false
    }
  }, [platform, tool])
  return levels
}

/**
 * A single menu row.
 *
 * The selected mark only ever goes in **one column on the left**. Putting it on the right would
 * shift its horizontal position from row to row depending on label length, so the eye would
 * have to scan the whole list to see what is selected. Always reserving that empty column keeps
 * the start of the text aligned in one line, whether the mark is there or not.
 */
function MenuRow({
  label,
  hint,
  selected,
  onPick,
  testId,
  title,
}: {
  label: string
  hint?: string
  selected: boolean
  onPick: () => void
  testId: string
  title?: string
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-testid={testId}
      title={title}
      onClick={onPick}
      className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left transition-colors ${
        selected ? 'text-ink' : 'text-ink-muted hover:bg-surface-hover/25'
      }`}
    >
      <span className="w-2 shrink-0 text-[10px] leading-none text-ink-muted" aria-hidden>
        {selected ? '✓' : ''}
      </span>
      {/*
        The label wins. The hint used to be shrink-0, so as space ran out **the label shrank
        all the way to zero** — the description stayed and the name vanished (the Normal
        disappearance incident). Lowering the label's shrink weight lets it hold out the
        longest, but when the label itself is long, like a model name, it still gets truncated
        (min-w-0 truncate is unchanged).
      */}
      <span className="min-w-0 shrink-[0.2] truncate text-[12px]">{label}</span>
      {hint && <span className="readout ml-auto min-w-0 truncate text-[10px] text-ink-faint">{hint}</span>}
    </button>
  )
}

function MenuSection({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="border-t border-line py-1 first:border-t-0">
      <p className="readout px-2.5 py-0.5 text-[10px] uppercase text-ink-faint">{label}</p>
      {/* Why this group is different is written at the top of the group — repeating it on
      every row would make the list unreadable */}
      {note && <p className="px-2.5 pb-1 text-[10px] leading-relaxed text-ink-faint">{note}</p>}
      {children}
    </div>
  )
}

export function SessionSettings({
  sessionId,
  tool,
  model,
  effort,
  verbosity,
  serviceTier,
  preset,
  live,
  onOpenChange,
}: {
  sessionId: string
  tool: ToolName
  model: string | null
  effort: string | null
  /** Response length (#54). null means the tool's default */
  verbosity: string | null
  /** Response speed (Codex's service_tier). null means the tool's default */
  serviceTier: string | null
  preset: PermissionPreset
  /** Whether the process is alive — Claude only returns a model list once a session is alive */
  live: boolean
  /**
   * Tells the outside when the menu opens and closes (for the grid's collapsed composer).
   *
   * A collapsed composer folds back down once the hand leaves it, and this menu opens **on top
   * of** that composer — the ground must not disappear from under it while a choice is being
   * made, so it is held open for as long as the menu is open.
   */
  onOpenChange?: (open: boolean) => void
}) {
  const update = useStore((s) => s.updateSessionSettings)
  const { models, reason } = useModels(tool, live)
  const verbosities = useVerbosities(tool)
  const [open, setOpen] = useState(false)
  /** Mid closing-animation — unmounts only after it has fully settled (cc-hang-out) */
  const [closing, setClosing] = useState(false)
  // Tells the outside when it opens/closes (the collapsed composer must not fold away meanwhile)
  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])
  const close = useCallback(() => {
    setOpen(false)
    setClosing(true)
  }, [])
  const rootRef = useRef<HTMLSpanElement>(null)

  const current = models.find((m) => m.id === model)
  // A model not in the list (set directly, or fetched while the list could not be read) is kept
  // so it is not lost
  const options = model && !current ? [...models, { id: model, label: model, efforts: [], defaultEffort: null, tiers: [] }] : models

  /*
   * Closes on an outside click or Esc.
   *
   * Unlike a `<select>`, the browser does not close this menu on its own. Once it is open, a
   * menu left sitting there becomes a wall blocking the composer, so every way to close it is
   * handled here in one place. (When a confirmation dialog opens, this closes first, so Esc is
   * never consumed by two places at once.)
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // The inbox and modals must not close along with it — only the innermost open thing closes
      e.stopPropagation()
      close()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])

  // With reduced-motion, animationend never fires — a timer guarantees it finishes
  useEffect(() => {
    if (!closing) return
    const t = window.setTimeout(() => setClosing(false), 200)
    return () => window.clearTimeout(t)
  }, [closing])

  // The `/model` GUI command (2026-09-07) — a signal from the composer to open this session's
  // menu
  const menuRequest = useStore((s) => s.settingsMenuRequest)
  useEffect(() => {
    if (menuRequest?.sessionId !== sessionId) return
    setClosing(false)
    setOpen(true)
  }, [menuRequest, sessionId])

  /*
   * **Picking an option does not close the menu** (requested by a user on 2026-09-06). It
   * started out as "close on pick, except for model", but the asymmetry of effort closing the
   * menu while model kept it open actually broke expectations more. This menu is a place for
   * touching several knobs in a row — there are three ways to close it (outside click, Esc,
   * the toggle button), and the first click on the composer already counts as an outside click,
   * so it never becomes a wall in the way.
   */
  const choose = (patch: Parameters<typeof update>[1]) => void update(sessionId, patch)

  const modelLabel = current?.label ?? model ?? 'Default'
  // The current values must be readable without opening the menu — this pays back the cost of
  // hiding them inside one.
  // verbosity shares level names with effort (low/medium/high), so shown bare it would be
  // ambiguous which is which — this labels it
  const summary = [
    modelLabel, effort, verbosity && `${verbosity} verbosity`,
    // Shows the tier's name (Fast), not its id (priority) — exactly the word the person picked
    serviceTier && (current?.tiers.find((t) => t.id === serviceTier)?.name ?? serviceTier),
    PRESETS.find((p) => p.value === preset)?.label,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <span className="relative flex min-w-0 items-center" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="settings-open"
        title={
          reason
            ? `Could not load models: ${reason}`
            : 'Model, effort, permissions — applies from the next turn'
        }
        className="flex min-w-0 cursor-pointer items-center gap-1 rounded border border-line bg-surface-raised px-1.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:text-ink"
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronIcon open={open} size={10} />
      </button>

      {(open || closing) && (
        /*
          Opens upward. This row sits at the bottom of the window (or the grid pane), so opening
          downward would get clipped immediately — the autocomplete menu uses the same direction
          for the same reason.
          cc-hang on the way up, cc-hang-out on the way down — not a target while it is closing.
        */
        <div
          role="menu"
          data-testid="settings-menu"
          onAnimationEnd={() => {
            if (!open) setClosing(false)
          }}
          className={`absolute bottom-full left-0 z-30 mb-1 max-h-72 w-56 overflow-y-auto overflow-x-hidden rounded border border-line bg-surface-raised shadow-(--shadow-popover-up) ${
            open ? 'cc-hang' : 'cc-hang-out pointer-events-none'
          }`}
        >
          <MenuSection label="Model">
            {/*
              If the tool already supplies its own 'default' entry (Claude's `default`), this
              does not add a second one — two rows meaning the same thing leaves no way to know
              which one to pick.
            */}
            {!models.some((m) => m.id === 'default') && (
              <MenuRow
                testId="settings-model-default"
                label="Default"
                selected={!model}
                onPick={() => choose({ model: null, effort: null })}
              />
            )}
            {options.map((m) => (
              <MenuRow
                key={m.id}
                testId={`settings-model-${m.id}`}
                label={m.label}
                title={m.description}
                selected={m.id === model}
                // Effort and speed are reset when the model changes — support differs from
                // model to model, so carrying the old value over would silently leave an
                // unsupported combination in place
                onPick={() => choose({ model: m.id, effort: null, serviceTier: null })}
              />
            ))}
          </MenuSection>

          {/* Effort only shows for a model that supports it — showing an option that does
          nothing would be a lie */}
          {current && current.efforts.length > 0 && (
            <MenuSection label="Effort">
              <MenuRow
                testId="settings-effort-default"
                label="Default"
                selected={!effort}
                onPick={() => choose({ effort: null })}
              />
              {current.efforts.map((lv) => (
                <MenuRow
                  key={lv}
                  testId={`settings-effort-${lv}`}
                  label={lv}
                  selected={lv === effort}
                  onPick={() => choose({ effort: lv })}
                />
              ))}
            </MenuSection>
          )}

          {/* Response length (#54) — only shows when the tool offers this knob. Measured: 82
          words for low, 269 for high (same question) */}
          {verbosities.length > 0 && (
            <MenuSection label="Verbosity" note="How long answers run — shorter arrives sooner.">
              <MenuRow
                testId="settings-verbosity-default"
                label="Default"
                selected={!verbosity}
                onPick={() => choose({ verbosity: null })}
              />
              {verbosities.map((lv) => (
                <MenuRow
                  key={lv}
                  testId={`settings-verbosity-${lv}`}
                  label={lv}
                  selected={lv === verbosity}
                  onPick={() => choose({ verbosity: lv })}
                />
              ))}
            </MenuSection>
          )}

          {/* Response speed — only shows when the model offers tiers (measured: gpt-5.4+ has
          one, Fast; mini has none) */}
          {current && current.tiers.length > 0 && (
            <MenuSection label="Speed" note="Faster answers spend more of your usage.">
              <MenuRow
                testId="settings-tier-default"
                label="Default"
                selected={!serviceTier}
                onPick={() => choose({ serviceTier: null })}
              />
              {current.tiers.map((t) => (
                <MenuRow
                  key={t.id}
                  testId={`settings-tier-${t.id}`}
                  label={t.name}
                  title={t.description}
                  selected={t.id === serviceTier}
                  onPick={() => choose({ serviceTier: t.id })}
                />
              ))}
            </MenuSection>
          )}

          {/*
            **There is no role group here** (removed on 2026-09-01). There used to be a row
            that promoted a session to "project orchestrator", but once the seat that directs
            sessions within a project also became the worktree manager (#69), even the person
            who built it confused the two, and the promotion was never actually used. The
            director's seat comes from the relationship (having children makes it a manager) —
            it is not something to pick.
          */}

          <MenuSection label="Permissions">
            {PRESETS.map((p) => (
              <MenuRow
                key={p.value}
                testId={`settings-preset-${p.value}`}
                label={p.label}
                hint={p.hint}
                selected={p.value === preset}
                onPick={() => choose({ permissionPreset: p.value })}
              />
            ))}
          </MenuSection>

          {/*
            **There is no switching agents here** (decided in dogfooding).

            The conversation does not carry over, so changing the tool from this menu was never
            "switching" — it was "starting a new conversation", and creating a new session
            already does that, more honestly. It amounted to a second door doing the same thing
            under a different name, and every time, a confirmation dialog had to explain what
            would be kept and what would be lost. A half feature gets removed.

            The one remaining exception is the orchestrator, and that lives in app settings
            (Cmd+,) under Orchestrator — because it is the only session that exists exactly once
            per app, so "create a new one with a different tool" does not make sense for it.
            It is a value scoped to the install, so app settings is the right place for it too.
          */}
        </div>
      )}

    </span>
  )
}
