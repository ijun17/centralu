import { z } from 'zod'
import { isRecord } from '../tolerant.js'
import { AgentModels } from './tools.js'

/**
 * Screen preferences, how the person wants the app to behave: one record rather than a `setX` method per switch (as
 * `updates.setAuto`), so the next preference costs one field, not a method, a handler and a port member.
 */
export const ThemeMode = z.enum(['dark', 'light', 'system'])
export type ThemeMode = z.infer<typeof ThemeMode>

/**
 * The app-wide text size steps, as the root's CSS zoom: UI text sizes are pinned in px, and growing only the text
 * breaks a narrow grid panel's wrapping first, so the whole screen scales like the OS's display scaling (`useTextZoom`).
 */
export const TEXT_SIZES = [0.85, 0.925, 1, 1.1, 1.25] as const

/** The nearest step, for a stored value from another build or a hand edit */
export function nearestTextSize(value: number): number {
  let best: number = TEXT_SIZES[2]
  for (const step of TEXT_SIZES) if (Math.abs(step - value) < Math.abs(best - value)) best = step
  return best
}

export type NotifyPolicy = {
  approval: boolean
  error: boolean
  /** A finish where it cannot be seen: it leaves a card, and card and sound go together, or cards pile up quietly */
  done: boolean
  /** Once, when every session has finished its work */
  allDone: boolean
  /** Also while the app is in front (off by default: a notice about what is in front of you is noise) */
  whenFocused: boolean
  /** On by default: the macOS banner path is dead (measured), so sound is what reaches someone away, even next room */
  sound: boolean
}

export const DEFAULT_NOTIFY_POLICY: NotifyPolicy = {
  approval: true,
  error: true,
  done: true,
  allDone: true,
  whenFocused: false,
  sound: true,
}

/**
 * Reads a policy field by field (docs/stored-shapes.md "The rules"). An unknown switch is dropped: the screen rewrites
 * the workspace snapshot whole, so a newer build's extra switch falls back to its own default there.
 */
const isNotifyPolicyKey = (key: string): key is keyof NotifyPolicy => key in DEFAULT_NOTIFY_POLICY

export function readNotifyPolicy(raw: unknown): NotifyPolicy {
  const out = { ...DEFAULT_NOTIFY_POLICY }
  if (!isRecord(raw)) return out
  for (const key of Object.keys(out)) {
    const v = raw[key]
    if (typeof v === 'boolean' && isNotifyPolicyKey(key)) out[key] = v
  }
  return out
}

/**
 * When agents compact by themselves: docs/agent-host/context-compaction.md. Not each tool's own config, as Codex's
 * `config.toml` can hold a fixed 700000 for a smaller window; `controlled` off passes nothing, and the tools decide.
 */
export type AutoCompact = {
  controlled: boolean
  share: number
  /** Over it, a session at rest is compacted before its next turn; `share` stays the in-turn backstop */
  idleShare: number
  /** Tell the session quietly to call `compact_self` past `nudgeFirst` and `nudgeSecond` */
  nudge: boolean
  /** At or above `share` it is never told: the tool compacts first */
  nudgeFirst: number
  /** Null: `NUDGE_SECOND_GAP` below `share`, following it; always `NUDGE_MARGIN` below it at least (`nudgeShares`) */
  nudgeSecond: number | null
}

export const MIN_AUTO_COMPACT_SHARE = 0.2
export const MIN_IDLE_COMPACT_SHARE = 0.1
export const MAX_AUTO_COMPACT_SHARE = 0.95
export const MIN_NUDGE_SHARE = 0.1
export const MAX_NUDGE_SHARE = 0.9
/** The lowest second reminder: the first sits `NUDGE_MARGIN` under it and not under `MIN_NUDGE_SHARE`; one stored lower reads as this */
export const MIN_NUDGE_SECOND = 0.15
export const NUDGE_SECOND_GAP = 0.1
export const NUDGE_MARGIN = 0.05
export const DEFAULT_AUTO_COMPACT: AutoCompact = {
  controlled: true,
  share: 0.65,
  idleShare: 0.4,
  nudge: true,
  nudgeFirst: 0.45,
  nudgeSecond: null,
}

const hundredths = (n: number): number => Math.round(n * 100) / 100

/**
 * The two shares a session is told at, as in force (docs/agent-host/context-compaction.md). The first is held at least
 * `NUDGE_MARGIN` under the second, chosen or not: the one rule for a first reminder that does not fit, read by the host, the
 * setting as read (`readAutoCompact`) and Settings alike.
 */
export function nudgeShares(c: Pick<AutoCompact, 'share' | 'nudgeFirst' | 'nudgeSecond'>): {
  first: number
  second: number
} {
  const ceiling = hundredths(c.share - NUDGE_MARGIN)
  const second = hundredths(c.nudgeSecond ?? c.share - NUDGE_SECOND_GAP)
  const held = Math.min(ceiling, Math.max(MIN_NUDGE_SECOND, second))
  return { first: Math.max(MIN_NUDGE_SHARE, Math.min(c.nudgeFirst, hundredths(held - NUDGE_MARGIN))), second: held }
}

/** Reads the setting field by field (docs/stored-shapes.md "The rules"); a share lands inside its range, and it reads as in force */
export function readAutoCompact(raw: unknown): AutoCompact {
  return settledAutoCompact(readAutoCompactChosen(raw))
}

/** The same read, before the first share is held under the second: what was chosen or defaulted, to merge a change over */
export function readAutoCompactChosen(raw: unknown): AutoCompact {
  const out = { ...DEFAULT_AUTO_COMPACT }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  if ('controlled' in raw && typeof raw.controlled === 'boolean') out.controlled = raw.controlled
  if ('share' in raw && typeof raw.share === 'number' && Number.isFinite(raw.share))
    out.share = Math.min(MAX_AUTO_COMPACT_SHARE, Math.max(MIN_AUTO_COMPACT_SHARE, raw.share))
  if ('idleShare' in raw && typeof raw.idleShare === 'number' && Number.isFinite(raw.idleShare))
    out.idleShare = Math.min(MAX_AUTO_COMPACT_SHARE, Math.max(MIN_IDLE_COMPACT_SHARE, raw.idleShare))
  if ('nudge' in raw && typeof raw.nudge === 'boolean') out.nudge = raw.nudge
  if ('nudgeFirst' in raw && typeof raw.nudgeFirst === 'number' && Number.isFinite(raw.nudgeFirst))
    out.nudgeFirst = Math.min(MAX_NUDGE_SHARE, Math.max(MIN_NUDGE_SHARE, raw.nudgeFirst))
  if ('nudgeSecond' in raw && typeof raw.nudgeSecond === 'number' && Number.isFinite(raw.nudgeSecond))
    out.nudgeSecond = Math.min(MAX_NUDGE_SHARE, Math.max(MIN_NUDGE_SECOND, raw.nudgeSecond))
  return out
}

/**
 * The setting as read, so it can be saved again whole (docs/agent-host/context-compaction.md): a chosen second share the share
 * moved under is held 5 points below it, and the first share is the one in force (`nudgeShares`), never at or above the
 * second. A misfit choice the person makes is refused in `setUiPreferences`.
 */
export function settledAutoCompact(c: AutoCompact): AutoCompact {
  const nudgeSecond = c.nudgeSecond === null ? null : Math.min(c.nudgeSecond, hundredths(c.share - NUDGE_MARGIN))
  const next = { ...c, nudgeSecond }
  return { ...next, nudgeFirst: nudgeShares(next).first }
}

/** A factor on the body and code line heights; `normal` is the base */
export const LineHeight = z.enum(['compact', 'normal', 'relaxed'])
export type LineHeight = z.infer<typeof LineHeight>

export const UiPreferences = z.object({
  /**
   * Enter writes a newline and ⌘/Ctrl+Enter sends, for paragraph writers, whose slip sends a half-written prompt. Off
   * by default: Enter-sends is what every chat does, and moving it would break someone's most-used key.
   */
  sendWithModifierEnter: z.boolean(),
  /** Following the OS switches between the two themes the person picked (`themeDark`, `themeLight`) */
  themeMode: ThemeMode,
  /** A preset id or a theme file's id; a custom theme is a file in the data folder's `themes/`, to edit and share */
  themeDark: z.string().max(80),
  themeLight: z.string().max(80),
  /** Null by default (the chrome has no hue); colours focus, selection and checks, never the "waiting for you" signal */
  accent: z.string().max(80).nullable(),
  /** One family or a list; the app's stack always follows (app/typography.ts), for a font missing or without Korean */
  bodyFont: z.string().max(200),
  /** The same way, for terminals, code blocks, paths and readouts */
  codeFont: z.string().max(200),
  /** Prose and code blocks; fixed-row views (the code viewer, the diff, the commit graph) keep theirs */
  lineHeight: LineHeight,
  /** Here, not in the workspace snapshot: a way of looking, not where things are */
  textSize: z.number().transform(nearestTextSize),
  /** Ordinary sessions get read-only tools on their project (`read_session`, `recall`, the guide); read on each call */
  sessionTools: z.boolean(),
  /** Running children per project: null uses preset defaults (auto unlimited, otherwise 4); 0 is unlimited. */
  agentCeiling: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  /**
   * Levels of sessions that may start agents (start_agent, a fork, ask_project): 1 only a person-started session, 2 its
   * children too, 3 its grandchildren. Every preset keeps to it, `auto` included.
   */
  agentDepth: z.number().int().min(1).max(3).optional(),
  /** start_agent's model and effort per tool and difficulty, else the project's choice; the patch carries the whole map */
  agentModels: AgentModels.optional(),
  /**
   * Whether a session the hub's `auto` session starts here runs under `auto` too; off, under `normal`, and the hub's
   * card asks each time (for a shared computer). Absent reads on (`hubAutoOf`).
   */
  hubAuto: z.boolean().optional(),
  /**
   * Continue by itself a turn a usage limit stopped, at the reset, and one the network stopped, once it is back. This
   * computer's host reads them for its own sessions; absent reads on (`autoContinueOf`).
   */
  continueAfterLimit: z.boolean().optional(),
  continueOnNetwork: z.boolean().optional(),
  /**
   * Folded sidebar groups, `session:<id>` (children) and `app:<key>`: only folded ones are listed, so an untouched
   * group is open and a stale key does nothing. The patch carries the whole list.
   */
  foldedGroups: z.array(z.string().max(300)).max(500),
  /**
   * Here, not in the workspace snapshot the host cannot change, so the window and the Assistant share it. An older host
   * answers without it, and the window keeps the snapshot's. The host fills it on first read from the snapshot or the
   * defaults (`UiPreferenceStore`).
   */
  notifyPolicy: z
    .unknown()
    .transform((v) => readNotifyPolicy(v))
    .optional(),
  /** Absent reads as the default (`autoCompactOf`); an older host ignores it */
  autoCompact: z
    .unknown()
    .transform((v) => readAutoCompact(v))
    .optional(),
})
export type UiPreferences = z.infer<typeof UiPreferences>

/** What is left out keeps its value, so a screen loaded before a preference existed cannot undo it */
export const UiPreferencesPatch = UiPreferences.partial().extend({
  /** Only the switches that change: the host merges them, so writers of different switches do not undo each other */
  notifyPolicy: z
    .object({
      approval: z.boolean(),
      error: z.boolean(),
      done: z.boolean(),
      allDone: z.boolean(),
      whenFocused: z.boolean(),
      sound: z.boolean(),
    })
    .partial()
    .optional(),
  /** Only what changes, merged like the notification switches */
  autoCompact: z
    .object({
      controlled: z.boolean(),
      share: z.number().min(MIN_AUTO_COMPACT_SHARE).max(MAX_AUTO_COMPACT_SHARE),
      idleShare: z.number().min(MIN_IDLE_COMPACT_SHARE).max(MAX_AUTO_COMPACT_SHARE),
      nudge: z.boolean(),
      nudgeFirst: z.number().min(MIN_NUDGE_SHARE).max(MAX_NUDGE_SHARE),
      /** null: back to the default, below `share` by `NUDGE_SECOND_GAP` */
      nudgeSecond: z.number().min(MIN_NUDGE_SHARE).max(MAX_NUDGE_SHARE).nullable(),
    })
    .partial()
    .optional(),
})
export type UiPreferencesPatch = z.infer<typeof UiPreferencesPatch>

/**
 * Only sessions the person started may start agents: `auto` children each starting their own ran twelve sessions at
 * once and took a Mac's load average to 216 (#862).
 */
export const DEFAULT_AGENT_DEPTH = 1
export const MAX_AGENT_DEPTH = 3

/** Whether this computer takes `auto` from its hub's `auto` sessions: on unless the person turned it off */
export function hubAutoOf(prefs: Pick<UiPreferences, 'hubAuto'>): boolean {
  return prefs.hubAuto !== false
}

/** Which stops this computer continues by itself: each on unless the person turned it off */
export function autoContinueOf(prefs: Pick<UiPreferences, 'continueAfterLimit' | 'continueOnNetwork'>): { limit: boolean; network: boolean } {
  return { limit: prefs.continueAfterLimit !== false, network: prefs.continueOnNetwork !== false }
}

/** The auto-compact setting in force: the saved one, else the default (on, at 65%) */
export function autoCompactOf(prefs: Pick<UiPreferences, 'autoCompact'>): AutoCompact {
  return prefs.autoCompact ?? DEFAULT_AUTO_COMPACT
}

/** The notification switches in force: the saved ones, else the defaults (an older host has none) */
export function notifyPolicyOf(prefs: Pick<UiPreferences, 'notifyPolicy'>): NotifyPolicy {
  return prefs.notifyPolicy ?? DEFAULT_NOTIFY_POLICY
}

/** The agent depth in force: the saved one, else the default */
export function agentDepthOf(prefs: Pick<UiPreferences, 'agentDepth'>): number {
  return prefs.agentDepth ?? DEFAULT_AGENT_DEPTH
}

/** What someone who has never opened Settings gets */
export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  sendWithModifierEnter: false,
  themeMode: 'dark',
  themeDark: 'dark',
  themeLight: 'light',
  accent: null,
  bodyFont: '',
  codeFont: '',
  lineHeight: 'normal',
  textSize: 1,
  sessionTools: true,
  foldedGroups: [],
}

/**
 * Never throws: a missing, half-written or corrupt blob falls back to the defaults rather than failing the start, and
 * fields filled from the defaults let the record grow without a migration.
 */
export function parseUiPreferences(raw: unknown): UiPreferences {
  const out: UiPreferences = { ...DEFAULT_UI_PREFERENCES }
  if (!isRecord(raw)) return out
  const record = raw
  // Field by field, so one bad field (an older build's theme id, say) cannot discard the rest
  for (const [key, field] of Object.entries(UiPreferences.shape)) {
    if (!(key in record)) continue
    const parsed = field.safeParse(record[key])
    if (parsed.success) Object.assign(out, { [key]: parsed.data })
  }
  return out
}
