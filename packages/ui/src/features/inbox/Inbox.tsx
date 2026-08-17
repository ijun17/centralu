import { useEffect, useRef, useState } from 'react'
import { afterHandled } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useInbox } from '../../store/selectors.js'
import { Kbd, StateDot, formatWaiting, waitingTone } from '../../components/primitives.jsx'

/**
 * 인박스 (FR-15) — 자리로 돌아왔을 때의 진입점.
 * 프로젝트 구조를 무시하고 "지금 내 개입을 기다리는 것"만 긴급도 순으로 보여준다.
 */
export function Inbox() {
  const open = useStore((s) => s.inboxOpen)
  const toggle = useStore((s) => s.toggleInbox)
  const focusSession = useStore((s) => s.focusSession)
  const archive = useStore((s) => s.archive)
  const projects = useStore((s) => s.projects)
  const [now, setNow] = useState(() => Date.now())
  const items = useInbox(now)
  const [cursor, setCursor] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)

  // 경과 시간 갱신 (1초 폴링은 표시 전용 — 상태는 이벤트 구동)
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    // 인박스는 모달이다 — 키보드 소유권을 가져온다.
    // 메시지를 보낸 직후엔 입력창에 포커스가 남아 있어, 그대로 두면 d·j·k가 본문에 타이핑된다.
    ;(document.activeElement as HTMLElement | null)?.blur()
    panelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'j') setCursor((c) => Math.min(c + 1, items.length - 1))
      else if (e.key === 'ArrowUp' || e.key === 'k') setCursor((c) => Math.max(c - 1, 0))
      else if (e.key === 'Enter') {
        const item = items[cursor]
        if (item) {
          focusSession(item.id)
          toggle(false)
        }
      } else if (e.key === 'd') {
        // 아카이브는 인박스를 비우는 1급 수단 (없으면 응답대기가 쌓여 무용지물)
        const item = items[cursor]
        if (item) {
          const next = afterHandled(items, item.id)
          void archive(item.id)
          if (next) setCursor(Math.min(cursor, items.length - 2))
        }
      } else if (e.key === 'Escape') toggle(false)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, items, cursor, focusSession, toggle, archive])

  if (!open) return null

  return (
    <div
      className="absolute inset-0 z-20 flex items-start justify-center bg-void/80 pt-[12vh] backdrop-blur-[2px]"
      onClick={() => toggle(false)}
      data-testid="inbox"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Waiting"
        className="w-[640px] max-w-[90vw] overflow-hidden rounded-lg border border-edge bg-pit shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)] focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-baseline gap-2 border-b border-edge px-4 py-2.5">
          <h2 className="text-[12px] font-medium text-chalk">Waiting</h2>
          <span className="readout text-[11px] text-slate">{items.length}</span>
          <span className="ml-auto flex items-center gap-1 text-[10px] text-slate">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> Move
            <Kbd>↵</Kbd> Open
            <Kbd>d</Kbd> Dismiss
            <Kbd>esc</Kbd> Close
          </span>
        </header>

        {items.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-ash" data-testid="inbox-empty">
            Nothing waiting
            <span className="mt-1 block text-[11px] text-slate">Finished agents collect here</span>
          </p>
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto">
            {items.map((it, i) => (
              <li key={it.id}>
                <button
                  className={`flex w-full items-center gap-2.5 border-l-2 py-2 pl-3 pr-4 text-left transition-colors ${
                    i === cursor
                      ? 'border-l-ash bg-graphite/40'
                      : 'border-l-transparent hover:bg-graphite/20'
                  }`}
                  onClick={() => {
                    focusSession(it.id)
                    toggle(false)
                  }}
                  data-testid={`inbox-item-${it.id}`}
                >
                  <StateDot state={it.state} />
                  <span className={`truncate text-[13px] ${it.unread ? 'text-chalk' : 'text-ash'}`}>
                    {it.name}
                  </span>
                  <span className="truncate text-[11px] text-slate">
                    {(it.projectId ? projects[it.projectId]?.name : 'Orchestrator') ?? ''}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-2.5">
                    <span className="text-[11px] text-slate">
                      {it.state === 'waiting_approval'
                        ? 'Needs approval'
                        : it.state === 'error'
                          ? 'Error'
                          : 'Waiting for input'}
                    </span>
                    {/* 오래 기다릴수록 밝아진다 — 새 도형 없이 시간 압력만 말한다 */}
                    <span className={`readout w-16 text-right text-[11px] ${waitingTone(it.waitingMs)}`}>
                      {formatWaiting(it.waitingMs)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
