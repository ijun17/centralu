import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionState } from '@cc/protocol'
import { useCapability } from '../app/PlatformProvider.jsx'

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

/**
 * 시그니처 요소 — 키보드 우선 도구라는 정체성.
 *
 * `mod`·`alt`는 글리프가 아니라 **뜻**을 받는다 (이슈 #32). 이 맥에서 `⌘`인 키는 다른
 * 자판에서 `Ctrl`이고, 핸들러는 진작부터 둘 다 받고 있었다 — 화면만 없는 키를 누르라고
 * 말했다. `<Kbd>⌘</Kbd>`처럼 호출 지점에 기호를 적는 방식이 그 거짓말을 한 번에 열 파일로
 * 퍼뜨린 원인이라, 자판 이름은 이제 여기 한 곳에서만 들어온다.
 */
export function Kbd({
  children,
  live = false,
  mod = false,
  alt = false,
}: {
  children?: ReactNode
  live?: boolean
  /** 여기선 `⌘`, command 키가 없는 자판에선 `Ctrl` */
  mod?: boolean
  /** 여기선 `⌥`, 그 밖에선 `Alt` */
  alt?: boolean
}) {
  const keys = useCapability('shortcutKeys')
  return (
    <kbd className={`keycap ${live ? 'keycap-live' : ''}`}>
      {mod ? keys.mod : alt ? keys.alt : children}
    </kbd>
  )
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
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
  /*
   * **absolute가 아니라 fixed다** (도그푸딩: 사용량 도넛의 툴팁이 모달의 스크롤 상자에
   * 아래가 잘렸다). 트리거 안의 absolute는 조상 어딘가의 overflow에 반드시 잘린다 —
   * 사이드바(overflow-y-auto)의 버튼 툴팁도 같은 지뢰 위에 서 있었다. 뷰포트 기준으로
   * 띄우면 잘릴 상자가 없다. 계산은 RowMenu(사이드바 메뉴)와 같은 규칙이다:
   * 확대(--text-zoom)가 rect에는 곱해져 있고 fixed 길이에는 또 곱해질 것이므로,
   * 전부 레이아웃 px로 환산해 한 좌표계에서 계산한다.
   */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const a = anchorRef.current
    const el = tipRef.current
    if (!a || !el) return
    const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-zoom')) || 1
    const r = a.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const winW = window.innerWidth / zoom
    const winH = window.innerHeight / zoom
    const GAP = 4
    const EDGE = 8
    let top = placement === 'top' ? r.top / zoom - GAP - h : r.bottom / zoom + GAP
    // 창을 벗어나면 반대쪽으로 뒤집는다 — placement는 기본 방향이지 약속이 아니다
    if (placement === 'bottom' && top + h > winH - EDGE) top = r.top / zoom - GAP - h
    else if (placement === 'top' && top < EDGE) top = r.bottom / zoom + GAP
    const left = Math.max(
      EDGE,
      Math.min(align === 'right' ? r.right / zoom - w : r.left / zoom, winW - EDGE - w),
    )
    setPos({ top, left })
  }, [open, placement, align])
  /*
   * 스크롤하면 잰 자리가 낡는다 — 다시 재는 대신 닫는다. 호버 툴팁은 손이 그대로면
   * 곧 다시 뜨고, 스크롤 중인 손은 어차피 다른 데를 보고 있다.
   */
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [open])
  return (
    <span
      ref={anchorRef}
      className="relative inline-flex min-w-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          ref={tipRef}
          role="tooltip"
          data-testid={testId}
          className="pointer-events-none fixed z-50 w-max max-w-64 rounded border border-edge bg-panel px-2 py-1.5 text-[11px] leading-relaxed text-ash shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
          style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
        >
          {content}
        </span>
      )}
    </span>
  )
}
