import { useState, type ReactNode } from 'react'
import type { SessionState } from '@cc/protocol'

/**
 * 상태 표시 (FR-12).
 * 색이 없으므로 긴급도는 밝기가, 종류는 형태가 말한다.
 * 승인 대기만 순백이고 나머지는 어둡다 — 화면에서 가장 밝은 것이 곧 나를 기다리는 것이다.
 */
const SIGNAL: Record<SessionState, { glyph: string; tone: string; label: string }> = {
  waiting_approval: { glyph: '●', tone: 'beacon', label: 'Awaiting approval' },
  error: { glyph: '✕', tone: 'text-beacon', label: 'Error' },
  waiting_input: { glyph: '○', tone: 'text-ash', label: 'Waiting for input' },
  working: { glyph: '◆', tone: 'text-ash breathe', label: 'Working' },
  limited: { glyph: '▬', tone: 'text-slate', label: 'Limit reached' },
  idle: { glyph: '·', tone: 'text-slate', label: 'Idle' },
}

/** 상태의 한국어 이름. 점을 안 그리는 자리(도구 표식 등)에서도 같은 말을 써야 한다 */
export const stateLabel = (state: SessionState): string => SIGNAL[state].label

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
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
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

/**
 * 툴팁.
 *
 * 브라우저 기본 title은 1~2초를 기다려야 뜨고 생김새를 앱과 맞출 수 없다.
 * 사이드바처럼 "평소엔 자리를 안 주지만 물어보면 바로 답해야 하는" 정보에는
 * 그 지연이 곧 정보가 없는 것과 같다.
 *
 * 마우스뿐 아니라 포커스에도 뜬다 — 키보드로만 도는 사람에게도 같은 정보가 필요하다.
 */
export function Tooltip({
  children,
  content,
  testId,
  placement = 'bottom',
  align = 'left',
}: {
  children: ReactNode
  content: ReactNode
  testId?: string
  /** 화면 아래쪽 요소는 위로 띄운다 — 아래로 띄우면 창 밖으로 나간다 */
  placement?: 'bottom' | 'top'
  /** 오른쪽 끝 요소는 오른쪽 정렬 — 왼쪽 정렬이면 툴팁이 창 밖으로 밀린다 */
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  return (
    <span
      className="relative inline-flex min-w-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          data-testid={testId}
          className={`pointer-events-none absolute z-30 w-max max-w-64 rounded border border-edge bg-panel px-2 py-1.5 text-[11px] leading-relaxed text-ash shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)] ${
            placement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
          } ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {content}
        </span>
      )}
    </span>
  )
}
