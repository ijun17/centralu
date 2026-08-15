import type { ReactNode } from 'react'
import type { SessionState } from '@cc/protocol'

/**
 * 상태 표시 (FR-12).
 * 색은 여기서만 쓴다 — 화면의 나머지는 검정이므로, 색이 보이면 그것이 곧 신호다.
 * 승인(앰버)과 응답대기(청색)는 형태까지 다르게 해 색약에서도 구분된다.
 */
const SIGNAL: Record<SessionState, { color: string; label: string; shape: 'dot' | 'ring' | 'bar' }> = {
  waiting_approval: { color: 'text-signal-act', label: '승인 대기', shape: 'dot' },
  error: { color: 'text-signal-fault', label: '오류', shape: 'bar' },
  waiting_input: { color: 'text-signal-calm', label: '응답 대기', shape: 'ring' },
  limited: { color: 'text-signal-hold', label: '한도', shape: 'bar' },
  working: { color: 'text-signal-run', label: '작업 중', shape: 'dot' },
  idle: { color: 'text-slate', label: '유휴', shape: 'ring' },
}

export function StateDot({ state }: { state: SessionState }) {
  const s = SIGNAL[state]
  const glyph = s.shape === 'dot' ? '●' : s.shape === 'ring' ? '○' : '▪'
  return (
    <span
      className={`${s.color} text-[9px] leading-none ${state === 'working' ? 'breathe' : ''}`}
      title={s.label}
      data-testid={`dot-${state}`}
      aria-label={s.label}
    >
      {glyph}
    </span>
  )
}

/** 시그니처 요소 — 키보드 우선 도구라는 정체성 */
export function Kbd({ children, live = false }: { children: ReactNode; live?: boolean }) {
  return <kbd className={`keycap ${live ? 'keycap-live' : ''}`}>{children}</kbd>
}

export function formatWaiting(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}

/**
 * 기다린 시간이 길수록 글자가 밝아진다.
 * 사람의 주의가 가장 비싼 자원이라는 전제를, 새 도형을 더하지 않고 밝기로만 말한다.
 */
export function waitingTone(ms: number): string {
  if (ms > 10 * 60_000) return 'text-chalk'
  if (ms > 3 * 60_000) return 'text-ash'
  return 'text-slate'
}
