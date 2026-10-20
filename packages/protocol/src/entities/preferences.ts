import { z } from 'zod'
import { isRecord } from '../tolerant.js'
import { AgentModels } from './tools.js'

/**
 * Preferences about the screen itself — how this person wants the app to behave, as
 * opposed to anything an agent does.
 *
 * **One record rather than a flag per errand.** Every screen preference before this one
 * either lived in the workspace snapshot (which is about *where things are*, not how they
 * behave) or nowhere at all, and the alternative on the table was a `setX` method per
 * toggle, the way `updates.setAuto` does it. That shape stops scaling the second there are
 * three of them: three methods, three handlers, three port members, all to carry booleans
 * that are read together at startup and never separately. This is a record so the next
 * preference costs one field.
 */
export const ThemeMode = z.enum(['dark', 'light', 'system'])
export type ThemeMode = z.infer<typeof ThemeMode>

/**
 * The five steps of the app-wide text size (#312 step 5): the root's CSS zoom factor, with 1 as the
 * default. Why a zoom and not a font size: every text size in the UI is pinned in px, and growing
 * only the text in a narrow grid panel breaks its wrapping first; scaling the whole screen by one
 * factor follows the same rule as the OS's own display scaling (the store's TEXT_SCALES comment).
 */
export const TEXT_SIZES = [0.85, 0.925, 1, 1.1, 1.25] as const

/** The nearest of the five steps — a stored value from another build, or a hand edit, lands on one */
export function nearestTextSize(value: number): number {
  let best: number = TEXT_SIZES[2]
  for (const step of TEXT_SIZES) if (Math.abs(step - value) < Math.abs(best - value)) best = step
  return best
}

/**
 * Where the text size used to live: an index (0..4) into the same five steps, in the workspace
 * snapshot's `textScale`. Read once to move it into the preferences, then never again; anything
 * that is not a number is no text size at all.
 */
export function textSizeFromLegacyStep(step: unknown): number | null {
  if (typeof step !== 'number' || !Number.isFinite(step)) return null
  return TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, Math.round(step)))] ?? null
}

export type NotifyPolicy = {
  /** Notify at once when an approval starts waiting */
  approval: boolean
  /** Notify at once when an error occurs */
  error: boolean
  /**
   * When a single session finishes a response **somewhere it cannot be seen**.
   *
   * Originally the sound came only "once, when everything has finished". That fell out of step once every
   * off-screen finish started leaving a card — the cards piled up every time but the sound came only at the
   * end, so if two sessions finished while the person was away, two cards had quietly piled up. A card and
   * a sound are the same event, so they go together.
   */
  done: boolean
  /** Once, when every session has finished its work */
  allDone: boolean
  /**
   * Whether to notify even while the app is in the foreground (default: no — a notification about something
   * right in front of you is noise)
   */
  whenFocused: boolean
  /**
   * Whether to make a sound.
   *
   * Since we measured that the macOS banner path is dead, **sound has been the main signal while the person
   * is away**. It is the only signal that reaches them even in the next room, so it is on by default.
   */
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
 * Reads a policy from the workspace snapshot, field by field (#384). A snapshot an older build wrote
 * lacks the switches added since (`done` came after `allDone`), and a missing switch must take its
 * default rather than read as off; a value that is not a boolean is no choice either. Fields this
 * build does not know are dropped: the screen rewrites the snapshot whole on its next change, so a
 * newer build's extra switch falls back to its own default there.
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

/** Line height (#312 step 5): a factor on the body and code line heights; `normal` is today's values */
export const LineHeight = z.enum(['compact', 'normal', 'relaxed'])
export type LineHeight = z.infer<typeof LineHeight>

export const UiPreferences = z.object({
  /**
   * Enter writes a newline and ⌘/Ctrl+Enter sends, instead of the other way round.
   *
   * It exists for people who write prompts in paragraphs. Shift+Enter has always made a
   * newline, but reaching for Shift on every line break while Enter sits there ready to
   * send mid-thought means the cost of a slip is a half-written instruction already on its
   * way to an agent — and you cannot unsend it.
   *
   * **Off by default, and that is not timidity.** Enter-sends is what every chat window
   * does, so it is what an unfamiliar hand expects; and for someone already using this app,
   * silently moving send onto a different key would break the one keystroke they use more
   * than any other. A preference that has to be asked for is worse than no preference —
   * a preference that changes under you is worse than both.
   */
  sendWithModifierEnter: z.boolean(),
  /**
   * Which side of the theme the screen shows (#312): always the dark one, always the light one,
   * or whichever the OS is set to. The two sides are chosen separately (`themeDark`,
   * `themeLight`) so that following the OS switches between two themes the person picked,
   * rather than between whatever the app thinks dark and light should be.
   */
  themeMode: ThemeMode,
  /**
   * The theme for the dark side: a preset id (`dark`, …) or a theme file's id. Only the choice
   * lives here; a custom theme itself is a file in the data folder's `themes/` (theme.ts), so it
   * can be edited by hand or by an agent and shared as a file.
   */
  themeDark: z.string().max(80),
  /** The theme for the light side: a preset id (`light`, …) or a theme file's id */
  themeLight: z.string().max(80),
  /**
   * An accent colour, or null for none (the default: the app is achromatic, and brightness is
   * what speaks urgency). When set it colours focus, selection and checked
   * controls — never the signal colour, which stays the one thing reserved for "waiting for you".
   */
  accent: z.string().max(80).nullable(),
  /**
   * The body font, as the person wrote it: one family (`Inter`) or a list (`"IBM Plex Sans", Inter`).
   * Empty is the app's own stack. The app's stack is always appended after it (app/typography.ts),
   * so a font that is not installed, or one without Korean, falls back to what shows today.
   */
  bodyFont: z.string().max(200),
  /** The code font, the same way: terminals, code blocks, paths and readouts. Empty is the app's own stack */
  codeFont: z.string().max(200),
  /** Line height of prose and code blocks. Fixed-row views (the code viewer, the diff, the commit graph) stay as they are */
  lineHeight: LineHeight,
  /**
   * The app-wide text size, one of `TEXT_SIZES` (a zoom factor, 1 = default). It lived in the
   * workspace snapshot as a step index (`textScale`) before #312; it is a way of looking, not a
   * place things are, so it moved here with the rest of Appearance. Any number is accepted and
   * lands on the nearest step, so a value from another build never throws the record away.
   */
  textSize: z.number().transform(nearestTextSize),
  /**
   * Whether ordinary sessions get Centralu's light, read-only tools (#320): their own project's
   * sessions (`read_session`, which lists them when given no id), a search of that project's past
   * conversations (`recall`) and the app guide. **On by default** (owner decision, 2026-10-05) — a
   * session asked "what did the other session do?" should be able to look. Not a screen
   * preference, but this is the one record the person's settings already live in; the host reads
   * it when a session starts and on each call.
   */
  sessionTools: z.boolean(),
  /** Running children per project: null uses preset defaults (auto unlimited, otherwise 4); 0 is unlimited. */
  agentCeiling: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  /**
   * How many levels of sessions may start agents (#867): at 1 only a session the person started starts agents (start_agent,
   * a fork, ask_project); at 2 its children do too, at 3 its grandchildren. Every preset keeps to it, `auto` included.
   * Optional, like agentCeiling: a record from before it has none and reads as `DEFAULT_AGENT_DEPTH` (`agentDepthOf`).
   */
  agentDepth: z.number().int().min(1).max(3).optional(),
  /**
   * The model and effort start_agent uses per tool and difficulty (#729), when the caller names a difficulty and no
   * model. A difficulty with nothing chosen falls back to the project's remembered choice, as a call without one does.
   * Optional, like agentCeiling: a record from before it has none. The patch carries the whole map.
   */
  agentModels: AgentModels.optional(),
  /**
   * Whether a session a linked computer's `auto` session starts on this one runs under `auto` too (#1273): start_agent
   * with a machine, from the computer this one is linked to as its hub. On by default (owner decision 2026-10-19); off,
   * such a session runs under `normal` and the hub's card asks each time, for a computer the person shares. Optional, as
   * agentDepth: a record from before it has none and reads as on (`hubAutoOf`).
   */
  hubAuto: z.boolean().optional(),
  /**
   * The sidebar groups the person folded (#666): the children of a session (`session:<id>`) and the
   * sessions of an app (`app:<key>`). Only folded groups are listed, so a group nobody touched is
   * open and an unknown or stale key does nothing. A way of looking, kept with the other screen
   * preferences so it survives a restart; the patch carries the whole list, since a list cannot be
   * patched by one entry.
   */
  foldedGroups: z.array(z.string().max(300)).max(500),
  /**
   * The notification switches (#1306): which events notify, and whether they make a sound. They lived in the window's
   * workspace snapshot, which the window writes whole and the host cannot change; here the window and the orchestrator
   * share one record. **Optional**, like `agentCeiling`: a record from before it has none, and a host from before it
   * answers without it (the window then keeps the snapshot's). The host fills it once on the first read, from the
   * snapshot's `notifyPolicy` or the defaults (`UiPreferenceStore`), so it is there from then on. Read field by field
   * (`readNotifyPolicy`): a switch a build does not know is dropped, a missing one takes its default.
   */
  notifyPolicy: z
    .unknown()
    .transform((v) => readNotifyPolicy(v))
    .optional(),
})
export type UiPreferences = z.infer<typeof UiPreferences>

/**
 * A change to *some* of them. Whatever is left out keeps the value it had.
 *
 * Writing the whole record back would work today, with one field and one window. It stops
 * working the moment there are several: a screen that loaded before a preference existed
 * would post its own idea of the record and quietly undo the one it never knew about.
 * Saying only what changed cannot do that.
 */
export const UiPreferencesPatch = UiPreferences.partial().extend({
  /** Only the switches that change (#1306): the host merges them into the record, so two writers changing different switches do not undo each other */
  notifyPolicy: z
    .object({ approval: z.boolean(), error: z.boolean(), done: z.boolean(), allDone: z.boolean(), whenFocused: z.boolean(), sound: z.boolean() })
    .partial()
    .optional(),
})
export type UiPreferencesPatch = z.infer<typeof UiPreferencesPatch>

/**
 * The agent depth when none is saved (#867, owner decision 2026-10-16): only the sessions the person started may start
 * agents. Twelve sessions at once, started by `auto` children each starting their own, took a Mac's load average to 216
 * (#862).
 */
export const DEFAULT_AGENT_DEPTH = 1
/** The deepest the setting goes (#867): three levels of agents below the person's session */
export const MAX_AGENT_DEPTH = 3

/** Whether this computer takes `auto` from its hub's `auto` sessions (#1273): on unless the person turned it off */
export function hubAutoOf(prefs: Pick<UiPreferences, 'hubAuto'>): boolean {
  return prefs.hubAuto !== false
}

/** The agent depth in force: the saved one, else the default */
export function agentDepthOf(prefs: Pick<UiPreferences, 'agentDepth'>): number {
  return prefs.agentDepth ?? DEFAULT_AGENT_DEPTH
}

/** What someone who has never opened Settings gets. Each field's reason is on the field. */
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
 * Turn whatever was stored into a usable record.
 *
 * **Never throws.** The one thing this must not do is take the app down with it: these are
 * preferences, and a blob that is missing, empty, half-written by an older build or plain
 * corrupt is a reason to fall back to the defaults, not a reason to fail to start. Fields
 * that did not exist when the blob was written fill in from the defaults for the same
 * reason — that is what lets the record grow without a migration.
 */
export function parseUiPreferences(raw: unknown): UiPreferences {
  const out: UiPreferences = { ...DEFAULT_UI_PREFERENCES }
  if (!isRecord(raw)) return out
  const record = raw
  /*
   * **Field by field.** Parsing the record as a whole meant one bad field (a theme id an
   * older build wrote differently, say) threw away every other preference with it. Each field
   * falls back on its own.
   */
  for (const [key, field] of Object.entries(UiPreferences.shape)) {
    if (!(key in record)) continue
    const parsed = field.safeParse(record[key])
    if (parsed.success) Object.assign(out, { [key]: parsed.data })
  }
  return out
}
