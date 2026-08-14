import type { ReactNode } from 'react'
import type { SessionState } from '@cc/protocol'

/** 상태 점 — 긴급도가 색으로 보여야 한다 (FR-12: 승인과 응답대기를 절대 안 섞는다) */
const DOT: Record<SessionState, { cls: string; label: string; icon: string }> = {
  waiting_approval: { cls: 'text-rose-500', label: '승인 대기', icon: '●' },
  error: { cls: 'text-rose-600', label: '오류', icon: '■' },
  waiting_input: { cls: 'text-sky-400', label: '응답 대기', icon: '●' },
  limited: { cls: 'text-amber-500', label: '한도', icon: '◐' },
  working: { cls: 'text-emerald-500', label: '작업 중', icon: '◆' },
  idle: { cls: 'text-neutral-600', label: '대기', icon: '○' },
}

export function StateDot({ state }: { state: SessionState }) {
  const d = DOT[state]
  return (
    <span className={d.cls} title={d.label} data-testid={`dot-${state}`} aria-label={d.label}>
      {d.icon}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-neutral-700 bg-neutral-800 px-1 text-[10px] text-neutral-300">
      {children}
    </kbd>
  )
}

export function formatWaiting(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}
