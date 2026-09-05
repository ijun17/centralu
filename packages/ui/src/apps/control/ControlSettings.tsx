import { useState } from 'react'
import { setAppState, useAppState, useSessionSummaries } from '../api.js'
import type { ControlDoc } from './ControlRail.jsx'

/**
 * 관제 앱 설정 (#81) — 판정 숫자와 선언형 감시(체크포인트 v1)의 자리.
 *
 * 감시는 "지켜봐 주고, 걸리면 부른다"다 (멈춤 아님 — bypass 세션은 도중에 멈출 수
 * 없다). 패턴은 툴 호출 한 줄(`도구: 제목 경로들`)에 대한 부분 일치고, 세션을
 * 고르면 그 세션만 본다. 걸리면 레일 Notices에 high로 선다.
 */
export function ControlSettings() {
  const doc = useAppState<ControlDoc>('control')
  const sessions = useSessionSummaries()
  const [pattern, setPattern] = useState('')
  const [target, setTarget] = useState('')
  const m = doc?.metrics ?? {}
  const watches = doc?.watches ?? []

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
    <div className="text-[11px] text-ash" data-testid="control-settings">
      <p className="text-slate">Verdict counters — is the rail actually replacing the grid?</p>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
        <dt>Inline replies (gear-turns ended in the rail)</dt>
        <dd className="readout text-right text-chalk" data-testid="control-metric-inline">
          {m.inlineReplies ?? 0}
        </dd>
        <dt>Sessions opened via the rail</dt>
        <dd className="readout text-right text-chalk" data-testid="control-metric-opens">
          {m.railOpens ?? 0}
        </dd>
      </dl>

      <p className="mt-3 text-slate">
        Watches — when a tool call matches, a high-priority notice lands on the rail. It watches;
        it does not pause.
      </p>
      <ul className="mt-1.5 space-y-1">
        {watches.map((w) => (
          <li key={w.id} className="flex items-center gap-2" data-testid={`watch-${w.id}`}>
            <span className="readout min-w-0 flex-1 truncate text-chalk">{w.pattern}</span>
            <span className="shrink-0 text-[10px] text-slate">
              {w.sessionId ? (sessions[w.sessionId]?.name ?? w.sessionId) : 'all sessions'}
            </span>
            <button
              className="shrink-0 text-slate hover:text-chalk"
              onClick={() => remove(w.id)}
              data-testid={`watch-remove-${w.id}`}
              aria-label="Remove watch"
            >
              ×
            </button>
          </li>
        ))}
        {watches.length === 0 && <li className="text-slate">No watches yet.</li>}
      </ul>
      <div className="mt-1.5 flex gap-1.5">
        <input
          className="min-w-0 flex-1 rounded border border-edge bg-panel px-1.5 py-1 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
          placeholder="e.g. git commit"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          data-testid="watch-pattern"
        />
        <select
          className="shrink-0 rounded border border-edge bg-panel px-1 py-1 text-[11px] text-ash focus:outline-none"
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
          className="shrink-0 rounded border border-edge bg-panel px-2 py-1 text-[11px] text-chalk hover:border-graphite"
          onClick={add}
          data-testid="watch-add"
        >
          Add
        </button>
      </div>
    </div>
  )
}
