import { useEffect, useState } from 'react'
import type { ToolName, UsageSnapshot, UsageWindow } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { Tooltip } from '../../components/primitives.jsx'
import { Modal } from '../../components/Modal.jsx'
import { CloseIcon } from '../../components/icons.jsx'

/**
 * 사용량 (FR-9).
 *
 * **구독 한도만 다룬다** — 추가 결제(크레딧)는 범위 밖이다.
 *
 * 도구마다 창의 개수와 이름이 다르다(Claude는 5시간+주간, Codex는 주간 하나).
 * 그래서 UI는 창이 몇 개인지 모르는 채로 배열을 그린다 — 새 창이 생겨도 여기를 고치지 않는다.
 */
export function UsagePanel({ tool }: { tool: ToolName }) {
  const platform = usePlatform()
  const [state, setState] = useState<{
    loading: boolean
    reason?: string
    usage: UsageSnapshot | null
  }>({ loading: true, usage: null })

  useEffect(() => {
    let alive = true
    setState({ loading: true, usage: null })
    void platform.agents
      .usage(tool)
      .then((r) => alive && setState({ loading: false, usage: r.usage, reason: r.supported ? undefined : r.reason }))
      .catch((e: Error) => alive && setState({ loading: false, usage: null, reason: e.message }))
    return () => {
      alive = false
    }
  }, [platform, tool])

  if (state.loading) {
    return (
      <p className="px-4 py-6 text-center text-[12px] text-slate" data-testid="usage-loading">
        사용량을 읽는 중…
      </p>
    )
  }

  // 못 읽는 것과 없는 것은 다르다 — 이유를 그대로 보여준다
  if (!state.usage || state.usage.windows.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-[12px] leading-relaxed text-ash" data-testid="usage-unavailable">
        사용량을 볼 수 없습니다
        {state.reason && <span className="mt-1 block text-[11px] text-slate">{state.reason}</span>}
      </p>
    )
  }

  const { plan, windows, daily } = state.usage

  return (
    <div className="px-4 py-4" data-testid="usage-panel">
      {plan && (
        <p className="readout mb-3 text-[11px] text-slate" data-testid="usage-plan">
          {plan} 플랜
        </p>
      )}

      <div className="flex flex-wrap justify-center gap-6">
        {windows.map((w) => (
          <Donut key={`${w.id}-${w.scope ?? ''}`} window={w} />
        ))}
      </div>

      {/* 일별 토큰은 주는 도구만 있다 (Codex는 준다, Claude는 창 자체가 없다) */}
      {daily.length > 0 && <DailyTokens daily={daily} />}
    </div>
  )
}

/**
 * 도넛.
 *
 * 색이 없으므로 채운 만큼을 밝기로 말한다. 위험할수록 밝아진다 —
 * 화면에서 가장 밝은 것이 나를 기다리는 것이라는 규칙과 같은 결이다.
 */
function Donut({ window: w }: { window: UsageWindow }) {
  const R = 26
  const C = 2 * Math.PI * R
  const filled = (Math.max(0, Math.min(100, w.percent)) / 100) * C
  const tone = w.percent >= 90 ? 'text-beacon' : w.percent >= 70 ? 'text-chalk' : 'text-ash'

  return (
    <Tooltip
      testId={`usage-tip-${w.id}`}
      content={
        <span className="block">
          <span className="block text-chalk">
            {w.label}
            {w.scope && ` · ${w.scope}`}
          </span>
          <span className="readout mt-1 block">{w.percent}% 사용</span>
          <span className="readout block text-slate">{resetText(w.resetsAt)}</span>
        </span>
      }
    >
      <span className="flex flex-col items-center gap-1" data-testid={`usage-window-${w.id}`}>
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
          <circle cx="32" cy="32" r={R} fill="none" stroke="currentColor" strokeWidth="6" className="text-edge" />
          <circle
            cx="32"
            cy="32"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${C - filled}`}
            // 12시 방향에서 시작해야 사람이 읽는 방향과 맞는다
            transform="rotate(-90 32 32)"
            className={tone}
          />
        </svg>
        <span className={`readout text-[13px] leading-none ${tone}`}>{w.percent}%</span>
        <span className="text-[10px] text-slate">
          {w.label}
          {w.scope && ' ·'}
        </span>
      </span>
    </Tooltip>
  )
}

/** 남은 시간을 사람 단위로 — 정확한 시각보다 '얼마나 남았나'가 먼저다 */
function resetText(resetsAt: string | null): string {
  if (!resetsAt) return '초기화 시각 모름'
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (!Number.isFinite(ms)) return '초기화 시각 모름'
  if (ms <= 0) return '곧 초기화'
  const min = Math.floor(ms / 60000)
  if (min < 60) return `${min}분 후 초기화`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}시간 ${min % 60}분 후 초기화`
  return `${Math.floor(hour / 24)}일 ${hour % 24}시간 후 초기화`
}

/** 일별 토큰 — 최근 7일만. 막대는 그날 최대치 대비 길이다 */
function DailyTokens({ daily }: { daily: { date: string; tokens: number }[] }) {
  const recent = daily.slice(-7)
  const peak = Math.max(...recent.map((d) => d.tokens), 1)
  const today = recent.at(-1)

  return (
    <section className="mt-5 border-t border-edge pt-3" data-testid="usage-daily">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-[0.12em] text-slate">일별 토큰</span>
        {today && (
          <span className="readout ml-auto text-[11px] text-chalk">오늘 {formatTokens(today.tokens)}</span>
        )}
      </div>
      <ul className="mt-2 space-y-1">
        {recent.map((d) => (
          <li key={d.date} className="flex items-center gap-2">
            <span className="readout w-12 shrink-0 text-[10px] text-slate">{d.date.slice(5)}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-edge">
              <span
                className="block h-full rounded-full bg-ash"
                style={{ width: `${Math.round((d.tokens / peak) * 100)}%` }}
              />
            </span>
            <span className="readout w-14 shrink-0 text-right text-[10px] text-slate">
              {formatTokens(d.tokens)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(n)
}

/** 사용량 모달 — 상단바 계기판에서 연다 */
export function UsageModal() {
  const open = useStore((s) => s.usageOpen)
  const toggle = useStore((s) => s.toggleUsage)
  // 사용량은 계정 단위지만 도구마다 다르다 — **보고 있는 세션의** 도구를 쓴다.
  // 프로젝트 기본값으로 대신하면 섞어 쓸 때 엉뚱한 도구의 한도를 보여준다.
  const tool = useStore((s) => {
    const session = s.focusedSessionId ? s.sessions[s.focusedSessionId] : undefined
    if (session) return session.tool
    const projectId = s.focusedProjectId
    return (projectId ? s.projects[projectId]?.defaultTool : undefined) ?? 'claude'
  })

  if (!open) return null
  return (
    <Modal onClose={() => toggle(false)} testId="usage-modal" align="top">
      <div className="w-[420px] max-w-[92vw] rounded-lg border border-edge bg-pit shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]">
        <header className="flex items-center gap-2 border-b border-edge px-4 py-2">
          <h2 className="text-[13px] font-medium text-chalk">사용량</h2>
          <span className="readout text-[11px] text-slate">{tool === 'codex' ? 'Codex' : 'Claude Code'}</span>
          <button
            className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-slate hover:text-chalk"
            onClick={() => toggle(false)}
            data-testid="usage-close"
            aria-label="닫기"
          >
            <CloseIcon size={11} />
          </button>
        </header>
        <UsagePanel tool={tool} />
      </div>
    </Modal>
  )
}
