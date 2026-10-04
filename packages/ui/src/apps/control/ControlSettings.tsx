import { useState } from 'react'
import { setAppState, useAppState, useSessionSummaries } from '../api.js'
import type { ControlDoc, ForemanSettings } from '@cc/protocol'

/**
 * Control app settings (#81) — home for the judgment numbers and declarative watches
 * (checkpoint v1).
 *
 * A watch means "keep an eye on it, and call out when it matches" (not a pause — a session
 * running under bypass cannot be stopped partway). A pattern is a partial match against a single
 * tool-call line (`tool: title paths`), and picking a session narrows it to just that session.
 * A match lands as a high-priority notice on the rail.
 */
export function ControlSettings() {
  const doc = useAppState<ControlDoc>('control')
  const sessions = useSessionSummaries()
  const [pattern, setPattern] = useState('')
  const [target, setTarget] = useState('')
  const m = doc?.metrics ?? {}
  const watches = doc?.watches ?? []
  const foreman: ForemanSettings = doc?.foreman ?? { tool: 'claude', effort: 'high' }
  const saveForeman = (f: ForemanSettings) =>
    setAppState('control', { ...(doc ?? {}), foreman: f })

  const add = () => {
    const p = pattern.trim()
    if (!p) return
    setAppState('control', {
      ...(doc ?? {}),
      watches: [...watches, { id: crypto.randomUUID(), pattern: p, ...(target ? { sessionId: target } : {}) }],
    })
    setPattern('')
  }
  const remove = (id: string) =>
    setAppState('control', { ...(doc ?? {}), watches: watches.filter((w) => w.id !== id) })

  return (
    <div className="text-[11px] text-ink-muted" data-testid="control-settings">
      <p className="text-ink-faint">Verdict counters — is the rail actually replacing the grid?</p>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
        <dt>Inline replies (gear-turns ended in the rail)</dt>
        <dd className="readout text-right text-ink" data-testid="control-metric-inline">
          {m.inlineReplies ?? 0}
        </dd>
        <dt>Sessions opened via the rail</dt>
        <dd className="readout text-right text-ink" data-testid="control-metric-opens">
          {m.railOpens ?? 0}
        </dd>
      </dl>

      <p className="mt-3 text-ink-faint">
        Foreman — how task coordinators are spawned. Filtering member reports takes judgment, so
        cheap models are the wrong default (they flatter and forward).
      </p>
      <div className="mt-1.5 flex gap-1.5">
        <select
          className="shrink-0 rounded border border-line bg-surface-raised px-1 py-1 text-[11px] text-ink-muted focus:outline-none"
          value={foreman.tool}
          onChange={(e) => saveForeman({ ...foreman, tool: e.target.value })}
          data-testid="foreman-tool"
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <input
          className="min-w-0 flex-1 rounded border border-line bg-surface-raised px-1.5 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          placeholder="model (blank = tool default)"
          value={foreman.model ?? ''}
          onChange={(e) => saveForeman({ ...foreman, model: e.target.value || undefined })}
          data-testid="foreman-model"
        />
        <input
          className="w-16 rounded border border-line bg-surface-raised px-1.5 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          placeholder="effort"
          value={foreman.effort ?? 'high'}
          onChange={(e) => saveForeman({ ...foreman, effort: e.target.value || undefined })}
          data-testid="foreman-effort"
        />
      </div>

      <p className="mt-3 text-ink-faint">
        Watches — when a tool call matches, a high-priority notice lands on the rail. It watches;
        it does not pause.
      </p>
      <ul className="mt-1.5 space-y-1">
        {watches.map((w) => (
          <li key={w.id} className="flex items-center gap-2" data-testid={`watch-${w.id}`}>
            <span className="readout min-w-0 flex-1 truncate text-ink">{w.pattern}</span>
            <span className="shrink-0 text-[10px] text-ink-faint">
              {w.sessionId ? (sessions[w.sessionId]?.name ?? w.sessionId) : 'all sessions'}
            </span>
            <button
              className="shrink-0 text-ink-faint hover:text-ink"
              onClick={() => remove(w.id)}
              data-testid={`watch-remove-${w.id}`}
              aria-label="Remove watch"
            >
              ×
            </button>
          </li>
        ))}
        {watches.length === 0 && <li className="text-ink-faint">No watches yet.</li>}
      </ul>
      <div className="mt-1.5 flex gap-1.5">
        <input
          className="min-w-0 flex-1 rounded border border-line bg-surface-raised px-1.5 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          placeholder="e.g. git commit"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          data-testid="watch-pattern"
        />
        <select
          className="shrink-0 rounded border border-line bg-surface-raised px-1 py-1 text-[11px] text-ink-muted focus:outline-none"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          data-testid="watch-target"
        >
          <option value="">All sessions</option>
          {Object.values(sessions)
            .filter((s) => s.kind !== 'orchestrator')
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        <button
          className="shrink-0 rounded border border-line bg-surface-raised px-2 py-1 text-[11px] text-ink hover:border-line-strong"
          onClick={add}
          data-testid="watch-add"
        >
          Add
        </button>
      </div>
    </div>
  )
}
