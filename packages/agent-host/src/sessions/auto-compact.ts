import type { AutoCompact, SessionInfo } from '@cc/protocol'
import type { SettingAccess } from '../dev-services/store/settings.js'

/**
 * Where an agent compacts by itself, as Centralu sets it (#1376): the share of the model's context window the person chose
 * (60% unless changed), in tokens, for the tool to take at launch. Nothing when Centralu's control is off, or when the
 * model's window is not known yet. What a tool accepts of the number is its adapter's to enforce.
 */

/** The tokens to pass, or null for nothing */
export function autoCompactTokens(setting: AutoCompact, window: number | null): number | null {
  if (!setting.controlled || window === null || !Number.isFinite(window) || window <= 0) return null
  return Math.max(1, Math.round(window * setting.share))
}

/**
 * What the next start of a session passes, from one place: the launch (`SessionStarts`) and the session menu's answer
 * (`agents.autoCompact`) both ask it, so what the menu says is what the start does (#1376 review).
 */
export function autoCompactPlan(setting: AutoCompact, windows: ModelWindows, m: Pick<SessionInfo, 'tool' | 'model' | 'projectId'>): { controlled: boolean; share: number; tokens: number | null } {
  return { controlled: setting.controlled, share: setting.share, tokens: autoCompactTokens(setting, windows.of(m)) }
}

/** A model's window as last read, and the model the tool said it was for (an alias such as `haiku` moves between models) */
type Known = { window: number; model: string | null }

/**
 * The context window of each model, as the tools reported it (the window the context gauge shows), kept per tool and model
 * name across restarts. A tool reports a window with its token readings, so one is known after a model's first turn; a model
 * nobody has read a window from gets nothing at its first start, and the value from the next.
 *
 * **A reading taken under the setting says less than the model's window.** Claude's CLI reports the smaller of the model's
 * window and the `autoCompactWindow` it was started with (measured, CLI 2.1.296: a 1M model started at 133,000 reports 133,000;
 * a 200k one started at 613,000 reports 200,000). `started` is told the largest window such a process can report (the
 * adapter's `windowCeilingFor`), and `note` reads a reading against it:
 *  - below it, the reading is the model's real window, whatever was known: it is recorded, so a record that was too large
 *    corrects itself and Centralu's share applies again;
 *  - at it, the window is only known to be at least that. If the tool names the model (`resolved`) and it is the one the record
 *    was taken for, the record stands; if it is another (the alias, the project default or the person's own setting moved to
 *    another model) the record is dropped, so the next start passes nothing and learns the real window, which also lets a record
 *    that was too small rise.
 * A process without the setting, and a tool that reports the model's own window either way (Codex), always record what they read.
 *
 * The key is the tool and the model name; a session on the tool's default model has none of its own, and the default differs
 * between projects, so it is keyed by its project too.
 */
export class ModelWindows {
  private readonly known = new Map<string, Known | null>()
  /** The largest window each running process can report because of what it was started with, until it ends */
  private readonly ceilings = new Map<string, number>()

  constructor(private readonly settings: SettingAccess) {}

  private key(m: Pick<SessionInfo, 'tool' | 'model' | 'projectId'>): string {
    return `model_window:${m.tool}:${m.model ?? `default@${m.projectId ?? ''}`}`
  }

  /** A process of this session starts with a setting that caps the window it can report at `ceiling` (null: it does not) */
  started(sessionId: string, ceiling: number | null): void {
    if (ceiling === null) this.ceilings.delete(sessionId)
    else this.ceilings.set(sessionId, ceiling)
  }

  /** A reading of the session's window, with the model the tool says it is for when it says */
  note(m: Pick<SessionInfo, 'id' | 'tool' | 'model' | 'projectId'>, window: number, resolved?: string): void {
    if (!Number.isFinite(window) || window <= 0) return
    const key = this.key(m)
    const known = this.read(key)
    const ceiling = this.ceilings.get(m.id)
    if (ceiling !== undefined && window >= ceiling) {
      // Only "at least this window": the record stands for the model it was taken for, else it is not to be trusted
      if (known && resolved !== undefined && known.model === resolved) return
      this.write(key, null)
      return
    }
    if (known && known.window === window && known.model === (resolved ?? null)) return
    this.write(key, { window, model: resolved ?? null })
  }

  /** The model's window, or null when no session has read one */
  of(m: Pick<SessionInfo, 'tool' | 'model' | 'projectId'>): number | null {
    return this.read(this.key(m))?.window ?? null
  }

  private read(key: string): Known | null {
    if (this.known.has(key)) return this.known.get(key) ?? null
    const raw = this.settings.appSetting(key)
    let value: Known | null = null
    if (raw !== null) {
      try {
        const v: unknown = JSON.parse(raw)
        if (typeof v === 'object' && v !== null && 'window' in v && typeof v.window === 'number' && v.window > 0) {
          value = { window: v.window, model: 'model' in v && typeof v.model === 'string' ? v.model : null }
        }
      } catch {
        /* a damaged value is no record */
      }
    }
    this.known.set(key, value)
    return value
  }

  private write(key: string, value: Known | null): void {
    this.known.set(key, value)
    this.settings.setAppSetting(key, value === null ? '' : JSON.stringify(value))
  }
}
