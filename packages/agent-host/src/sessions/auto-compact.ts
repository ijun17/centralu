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
 * The context window of each model, as the tools reported it (the window the context gauge shows), kept per tool and model
 * across restarts. A tool reports a window with its token readings, so one is known after a model's first turn; a model
 * nobody has read a window from gets nothing at its first start, and the value from the next.
 *
 * **A reading taken under the setting is not the model's window.** Claude's CLI reports the smaller of the model's window and
 * the `autoCompactWindow` it was started with, so a session started at 60% reads 60% back, and 60% of that on the next
 * start: every restart would shrink the window until the clamp's floor. A process started with the setting (`started`) can
 * therefore only raise a window already known, never lower it (`note`); Codex reports the model's own window either way.
 *
 * The key is the tool and the model; a session on the tool's default model has none of its own, and the default differs
 * between projects, so it is keyed by its project too.
 */
export class ModelWindows {
  private readonly known = new Map<string, number>()
  /** What each running process was started with (`autoCompactTokens`), until it ends */
  private readonly startedWith = new Map<string, number>()

  constructor(private readonly settings: SettingAccess) {}

  private key(m: Pick<SessionInfo, 'tool' | 'model' | 'projectId'>): string {
    return `model_window:${m.tool}:${m.model ?? `default@${m.projectId ?? ''}`}`
  }

  /** A process of this session starts with `tokens` (or with nothing: null) */
  started(sessionId: string, tokens: number | null): void {
    if (tokens === null) this.startedWith.delete(sessionId)
    else this.startedWith.set(sessionId, tokens)
  }

  /** A reading of the session's window; one from a process started with the setting only counts when it is larger than what is known */
  note(m: Pick<SessionInfo, 'id' | 'tool' | 'model' | 'projectId'>, window: number): void {
    if (!Number.isFinite(window) || window <= 0) return
    const key = this.key(m)
    const known = this.known.get(key) ?? this.of(m)
    if (this.startedWith.has(m.id) && known !== null && window <= known) return
    if (known === window) return
    this.known.set(key, window)
    this.settings.setAppSetting(key, String(window))
  }

  /** The model's window, or null when no session has read one */
  of(m: Pick<SessionInfo, 'tool' | 'model' | 'projectId'>): number | null {
    const key = this.key(m)
    const cached = this.known.get(key)
    if (cached !== undefined) return cached
    const stored = Number(this.settings.appSetting(key))
    if (!Number.isFinite(stored) || stored <= 0) return null
    this.known.set(key, stored)
    return stored
  }
}
