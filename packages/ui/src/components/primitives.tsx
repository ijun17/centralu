import type { ReactNode } from 'react'
import type { SessionState } from '@cc/protocol'

/**
 * 상태 표시 (FR-12).
 * 색이 없으므로 긴급도는 밝기가, 종류는 형태가 말한다.
 * 승인 대기만 순백이고 나머지는 어둡다 — 화면에서 가장 밝은 것이 곧 나를 기다리는 것이다.
 */
const SIGNAL: Record<SessionState, { glyph: string; tone: string; label: string }> = {
  waiting_approval: { glyph: '●', tone: 'beacon', label: '승인 대기' },
  error: { glyph: '✕', tone: 'text-beacon', label: '오류' },
  waiting_input: { glyph: '○', tone: 'text-ash', label: '응답 대기' },
  working: { glyph: '◆', tone: 'text-ash breathe', label: '작업 중' },
  limited: { glyph: '▬', tone: 'text-slate', label: '한도 도달' },
  idle: { glyph: '·', tone: 'text-slate', label: '유휴' },
}

export function StateDot({ state }: { state: SessionState }) {
  const s = SIGNAL[state]
  return (
    <span
      className={`w-2.5 shrink-0 text-center text-[9px] leading-none ${s.tone}`}
      title={s.label}
      data-testid={`dot-${state}`}
      aria-label={s.label}
    >
      {s.glyph}
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
  if (ms > 10 * 60_000) return 'text-beacon'
  if (ms > 3 * 60_000) return 'text-chalk'
  return 'text-slate'
}
