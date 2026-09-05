import { useAppState } from '../api.js'
import type { ControlDoc } from './ControlRail.jsx'

/**
 * 관제 앱 설정 (#81) — 지금은 판정 숫자를 보여주는 자리다.
 * "계속 쓰는가"는 감이 아니라 숫자여야 하고(#80), 숫자는 보여야 숫자다.
 */
export function ControlSettings() {
  const doc = useAppState<ControlDoc>('control')
  const m = doc?.metrics ?? {}
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
    </div>
  )
}
