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
