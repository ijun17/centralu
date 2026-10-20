import { asObj, str } from '../../json-value.js'
import { type NormalizedEvent } from '@cc/protocol'
import { noticeWords } from './notices.js'

/** The thread settings a Codex model switch is measured against (#304) — Codex's own words for them. */
export type CodexThreadSettings = { model: string | null; effort: string | null; serviceTier: string | null }

/** The settings a `thread/start` or `thread/resume` answer says the thread runs with (top level, as answered on 0.160.0). */
export function threadSettingsOf(res: Record<string, unknown> | undefined): CodexThreadSettings | null {
  if (!res) return null
  const thread = asObj(res.thread)
  const model = str(res.model) || str(thread.model)
  if (!model) return null
  return {
    model,
    effort: str(res.reasoningEffort) || str(thread.reasoningEffort) || null,
    serviceTier: str(res.serviceTier) || null,
  }
}

/**
 * A thread whose settings changed under it (#304, not exercised: Centralu's own effort override per turn did not send
 * it in #58's survey). `thread/settings/updated {threadId, threadSettings}` carries the whole of them
 * (generated/v2/ThreadSettings.ts). They are compared with what the thread said it runs with, not with what Centralu
 * asked for: Codex answers a default with a concrete value (no model asked → `gpt-5.6-luna`), and comparing with the
 * request would call that a change. Only a real difference becomes a notice and a `settings_changed` the tool made,
 * whose other fields are what the process was launched with (`launched`) — the host applies only what differs from
 * those.
 */
export function threadSettingsChanged(
  sessionId: string,
  before: CodexThreadSettings | null,
  params: unknown,
  launched: { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null },
): { next: CodexThreadSettings | null; events: NormalizedEvent[] } {
  const s = asObj(asObj(params).threadSettings)
  const next: CodexThreadSettings = {
    model: str(s.model) || null,
    effort: str(s.effort) || null,
    serviceTier: str(s.serviceTier) || null,
  }
  if (!next.model) return { next: before, events: [] }
  if (!before) return { next, events: [] }
  const words = { model: 'model', effort: 'effort', serviceTier: 'speed' } as const
  const changed = (Object.keys(words) as (keyof CodexThreadSettings)[]).filter((k) => next[k] !== before[k])
  if (changed.length === 0) return { next, events: [] }
  const what = changed.map((k) => `${words[k]} ${before[k] ?? 'default'} → ${next[k] ?? 'default'}`).join(' · ')
  return {
    next,
    events: [
      { type: 'notice', sessionId, level: 'warning', text: `This thread's settings were changed outside Centralu: ${what}`, ...noticeWords('settings', '') },
      {
        type: 'settings_changed',
        sessionId,
        model: changed.includes('model') ? next.model : launched.model,
        effort: changed.includes('effort') ? next.effort : launched.effort,
        verbosity: launched.verbosity,
        serviceTier: changed.includes('serviceTier') ? next.serviceTier : launched.serviceTier,
        by: 'tool',
      },
    ],
  }
}

/**
 * What a thread runs with against what Centralu shows, right after `thread/resume` (#1369). The session's recorded model
 * is sent with the resume (`resumeThreadParams`), so a thread normally answers with it. Two cases are left:
 *  - Nothing is recorded (a session imported from a Codex thread started elsewhere, or one that never picked a model):
 *    the thread runs what it was last set with. Its model and effort become the session's settings, so the screen names
 *    what runs.
 *  - A model is recorded and the thread answers with another one (the provider put its own in the place of the one asked
 *    for): the answer wins, with a warning, for the same reason. Never one model on screen and another running.
 * The effort is adopted only together with the model: a session that keeps its model and has no effort chosen is on the
 * tool's default, and Codex answers a default with a concrete value (`threadSettingsChanged`), which would turn "default"
 * into a fixed effort on every wake. A recorded effort needs no look: it is sent with every turn.
 * Nothing differs: nothing returns. `answered` is `threadSettingsOf` of the answer.
 */
export function reconcileOpenedThread(
  sessionId: string,
  answered: CodexThreadSettings | null,
  recorded: { model: string | null; effort: string | null },
): { notice?: NormalizedEvent; settings?: { model: string; effort: string | null } } {
  if (!answered?.model || answered.model === recorded.model) return {}
  return {
    ...(recorded.model
      ? {
          notice: {
            type: 'notice' as const,
            sessionId,
            level: 'warning' as const,
            text: `Codex runs this thread with ${answered.model}, not the ${recorded.model} this session was set to; the session now shows ${answered.model}`,
            ...noticeWords('settings', ''),
          },
        }
      : {}),
    settings: { model: answered.model, effort: recorded.effort ?? answered.effort },
  }
}
