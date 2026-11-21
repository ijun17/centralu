import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useDismiss } from '../../components/useDismiss.js'
import { usePresence } from '../../components/presence.js'
import { ChevronIcon } from '../../components/icons.jsx'
import { autoCompactOf, launchRefusal, listedModel, type AdapterCapabilities, type ModelOption, type PermissionPreset, type ToolName } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { useStore } from '../../store/store.js'

/*
 * The settings menu below the composer (FR-7): one button with the values, not four selects a grid pane cannot fit. The
 * models are what the tool's API reports (Claude's `supportedModels()`, Codex's `model/list`), never hardcoded.
 */

// Short: 'Asks only for risky actions' (27 characters) filled the w-56 row and erased the word "Normal"
const PRESETS: { value: PermissionPreset; label: string; hint: string }[] = [
  { value: 'safe', label: 'Safe', hint: 'Asks for everything' },
  { value: 'normal', label: 'Normal', hint: 'Asks when risky' },
  { value: 'edits', label: 'Edits', hint: 'No card in project' },
  { value: 'auto', label: 'Auto', hint: 'Never asks' },
]

/** Cached by the host, as spawning the tool per open made the click slow */
export function useModels(
  tool: ToolName,
  live: boolean,
  /** The session's machine (#82): the models its own CLI offers there. Null: this computer */
  machine: string | null = null,
): { models: ModelOption[]; reason?: string } {
  const platform = usePlatform()

  /*
   * Read again on `live`: the Claude SDK lists models only through a running Query, so a sleeping session reads none.
   * Another tool or machine clears the list (one tool's models are not the other's, and Claude's can take seconds);
   * a wake refreshes the same tool's list in place.
   */
  const read = useLoad(() => platform.agents.models(tool, machine), [platform, tool, machine], [live])
  return useMemo(() => {
    if (read.error !== null) return { models: read.data?.models ?? [], reason: read.error }
    if (!read.data) return NO_MODELS
    return { models: read.data.models, reason: read.data.supported ? undefined : read.data.reason }
  }, [read.data, read.error])
}

const NO_MODELS: { models: ModelOption[]; reason?: string } = { models: [] }

const NO_LEVELS: string[] = []

function useCapabilities(tool: ToolName, machine: string | null): AdapterCapabilities | undefined {
  const platform = usePlatform()
  return useLoad(() => platform.agents.capabilities(tool, machine), [platform, tool, machine]).data
}

/** The check in a fixed left column, so it and the labels line up whatever the label's length */
function MenuRow({
  label,
  hint,
  selected,
  onPick,
  testId,
  title,
  disabled = false,
}: {
  label: string
  hint?: string
  selected: boolean
  onPick: () => void
  testId: string
  title?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-testid={testId}
      title={title}
      disabled={disabled}
      onClick={onPick}
      className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left transition-colors disabled:cursor-default disabled:opacity-40 ${
        selected
          ? 'text-ink hover:bg-surface-hover/50'
          : 'text-ink-muted hover:bg-surface-hover/50 hover:text-ink'
      }`}
    >
      <span className="w-2 shrink-0 text-2xs leading-none text-ink-muted" aria-hidden>
        {selected ? '✓' : ''}
      </span>
      {/* The label shrinks last,
          or the hint would outlive the name */}
      <span className="min-w-0 shrink-[0.2] truncate text-sm">{label}</span>
      {hint && <span className="ml-auto min-w-0 truncate text-2xs text-ink-faint">{hint}</span>}
    </button>
  )
}

// The chosen row is its check and brighter ink: a fill would read as the hover (owner, 2026-10-18)
function MenuSection({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="border-t border-line p-1 first:border-t-0">
      <p className="px-2 pb-0.5 pt-1 text-2xs text-ink-faint">{label}</p>
      {/* Once for the group,
          not on every row */}
      {note && <p className="px-2 pb-1 text-2xs leading-body text-ink-faint">{note}</p>}
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
  /** Response length (#54); null: the tool's default */
  verbosity: string | null
  /** Codex's service_tier; null: the tool's default */
  serviceTier: string | null
  preset: PermissionPreset
  live: boolean
  /** A folded composer stays up while the menu over it is open */
  onOpenChange?: (open: boolean) => void
}) {
  const update = useStore((s) => s.updateSessionSettings)
  // Where this agent compacts by itself is Centralu's setting (#1376): the host that runs the session says what its next start passes
  const compactSetting = useStore((s) => autoCompactOf(s.prefs))
  const compactPlatform = usePlatform()
  // A session on a linked machine runs that machine's CLI (#82): its models and knobs are asked there
  const machine = useStore((s) => s.sessions[sessionId]?.machine ?? null)
  const { models, reason } = useModels(tool, live, machine)
  const caps = useCapabilities(tool, machine)
  const verbosities = caps?.verbosities ?? NO_LEVELS
  const toolLabel = useStore((s) => s.tools.find((t) => t.name === tool)?.label ?? tool)
  // A preset the tool cannot keep stays in the menu, greyed, with the host's reason (`launchRefusal`)
  const presetRefusal = (p: PermissionPreset) => (caps ? launchRefusal(caps, toolLabel, { permissionPreset: p, projectTrusted: true }) : null)
  const [open, setOpen] = useState(false)
  // Read when the menu opens and again when the setting or the model changes. A linked machine answers for itself
  const compact = useLoad(
    () => (open ? compactPlatform.agents.autoCompact(sessionId) : null),
    [compactPlatform, sessionId, open],
    [compactSetting.controlled, compactSetting.share, model],
  )
  const { shown, leaving } = usePresence(open)
  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])
  const close = useCallback(() => setOpen(false), [])
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // The list's entry the model names: a full id (`claude-opus-5-5`) is its alias's entry (`opus`)
  const listed = listedModel(models, model)
  // A model the list does not hold (set directly, or the list could not be read) is kept so it is not lost. Once the list is
  // read it says so, and offers the efforts its models take, as the tool may accept them. A list without `resolved` on any row
  // (an older host) cannot tell, so it says nothing
  const says = models.some((m) => m.resolved)
  const unlisted: ModelOption | null = model && !listed
    ? {
        id: model,
        label: says ? `${model} (not in list)` : model,
        description: says ? `${toolLabel}'s list of models does not hold this one` : undefined,
        efforts: [...new Set(models.flatMap((m) => m.efforts))],
        defaultEffort: null,
        tiers: [],
      }
    : null
  const current = listed ?? unlisted ?? undefined
  const options = unlisted ? [...models, unlisted] : models

  useDismiss({ open, onClose: close, refs: [rootRef], returnFocusTo: triggerRef })

  // The `/model` GUI command opens this session's menu
  const menuRequest = useStore((s) => s.settingsMenuRequest)
  useEffect(() => {
    if (menuRequest?.sessionId !== sessionId) return
    setOpen(true)
  }, [menuRequest, sessionId])

  // No pick closes the menu, the model's included: it is for several knobs in a row, and a click on the composer closes it
  const choose = (patch: Parameters<typeof update>[1]) => void update(sessionId, patch)

  const modelLabel = listed?.label ?? model ?? 'Default'
  // The values read without opening the menu; verbosity is labelled, as it shares effort's level names
  const summary = [
    modelLabel,
    effort,
    verbosity && `${verbosity} verbosity`,
    // Shows the tier's name (Fast), not its id (priority) — exactly the word the person picked
    serviceTier && (current?.tiers.find((t) => t.id === serviceTier)?.name ?? serviceTier),
    PRESETS.find((p) => p.value === preset)?.label,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <span className="relative flex min-w-0 items-center" ref={rootRef}>
      <button
        ref={triggerRef}
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
        className="flex min-w-0 cursor-pointer items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted transition-colors hover:bg-surface-hover/50 hover:text-ink"
      >
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronIcon open={open} size={10} />
      </button>

      {shown && (
        // Upward, as the row is at the pane's bottom; no target while closing
        <div
          role="menu"
          data-testid="settings-menu"
          className={`absolute bottom-full left-0 z-30 mb-1 max-h-80 w-60 overflow-y-auto overflow-x-hidden rounded-bubble border border-line bg-surface-raised shadow-(--shadow-popover-up) ${
            leaving ? 'cc-hang-out pointer-events-none' : 'cc-hang'
          }`}
        >
          <MenuSection label="Model">
            {/* Not a second Default beside the tool's own
                (Claude's `default`) */}
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
                // A stored full id shows as its entry; picking the entry sets the alias, so the pin is named here
                title={m.id === listed?.id && model !== m.id ? `${m.label} · pinned ${model}` : m.description}
                selected={m.id === current?.id}
                // Reset: support differs per model
                onPick={() => choose({ model: m.id, effort: null, serviceTier: null })}
              />
            ))}
          </MenuSection>

          {/* Only for a model
              that takes it */}
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

          {/* #54, measured: 82 words at low,
              269 at high, for one question */}
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

          {/* Measured: gpt-5.4 and later offer one tier,
              Fast; mini none */}
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

          {compactSetting.controlled && !compact.loading && (
            <MenuSection label="Auto compact">
              <p data-testid="settings-auto-compact-note" className="px-2 pb-1 text-2xs leading-body text-ink-faint">
                {compact.error !== null
                  ? `Could not read where this session compacts (${compact.error}).`
                  : !compact.data?.controlled
                    ? "Centralu does not set this on the computer that runs it; the agent's own setting decides."
                    : compact.data.tokens === null
                      ? "Centralu has not read this model's window yet, so the agent's own setting decides until the session next starts after its first turn."
                      : `Compacts at ${Math.round(compact.data.share * 100)}% of the model's window (about ${compact.data.tokens.toLocaleString('en-US')} tokens) from the next start, set in Settings.`}
              </p>
            </MenuSection>
          )}

          {/* No role group: a manager (#69) is one by having children,
              not by a pick */}

          <MenuSection label="Permissions">
            {PRESETS.map((p) => {
              const refused = presetRefusal(p.value)
              return (
                <MenuRow
                  key={p.value}
                  testId={`settings-preset-${p.value}`}
                  label={p.label}
                  hint={refused ? 'Not available' : p.hint}
                  selected={p.value === preset}
                  disabled={refused !== null}
                  {...(refused ? { title: refused } : {})}
                  onPick={() => choose({ permissionPreset: p.value })}
                />
              )
            })}
          </MenuSection>

          {/*
            No tool switch: the conversation would not carry over, so it is a new session. The
            Assistant's tool, one per install, is in app settings.
          */}
        </div>
      )}
    </span>
  )
}
