import { useEffect, useState } from 'react'
import { afterHandled } from '@cc/core'
import { useStore } from '../../store/store.js'
import { useInbox } from '../../store/selectors.js'
import { StateDot, formatWaiting } from '../../components/primitives.jsx'

/**
 * 인박스 (FR-15) — 자리로 돌아왔을 때의 진입점.
 * 프로젝트 구조를 무시하고 "지금 내 개입을 기다리는 것"만 긴급도 순으로 보여준다.
 */
export function Inbox() {
  const open = useStore((s) => s.inboxOpen)
  const toggle = useStore((s) => s.toggleInbox)
  const focusSession = useStore((s) => s.focusSession)
  const archive = useStore((s) => s.archive)
  const [now, setNow] = useState(() => Date.now())
  const items = useInbox(now)

  // 경과 시간 갱신 (1초 폴링은 표시 전용 — 상태는 이벤트 구동)
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [open])

  const [cursor, setCursor] = useState(0)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      if (e.key === 'ArrowDown' || e.key === 'j') setCursor((c) => Math.min(c + 1, items.length - 1))
      else if (e.key === 'ArrowUp' || e.key === 'k') setCursor((c) => Math.max(c - 1, 0))
      else if (e.key === 'Enter') {
        const item = items[cursor]
        if (item) {
          focusSession(item.id)
          toggle(false)
        }
      } else if (e.key === 'd') {
        // dismiss = 아카이브. 인박스를 비우는 1급 수단 (없으면 응답대기가 쌓여 무용지물)
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
    <div className="absolute inset-0 z-20 flex items-start justify-center bg-black/50 pt-20" data-testid="inbox">
      <div className="w-[680px] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
          <span>인박스 — 내 개입을 기다리는 항목</span>
          <span className="text-neutral-600">↑↓ 이동 · Enter 열기 · d 아카이브 · Esc 닫기</span>
        </div>
        {items.length === 0 ? (
          <p className="p-8 text-center text-sm text-neutral-500" data-testid="inbox-empty">
            인박스 비움 ✓
          </p>
        ) : (
          <ul>
            {items.map((it, i) => (
              <li key={it.id}>
                <button
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-neutral-900 ${
                    i === cursor ? 'bg-neutral-900' : ''
                  }`}
                  onClick={() => {
                    focusSession(it.id)
                    toggle(false)
                  }}
                  data-testid={`inbox-item-${it.id}`}
                >
                  <StateDot state={it.state} />
                  <span className={`truncate ${it.unread ? 'font-semibold text-neutral-100' : 'text-neutral-300'}`}>
                    {it.name}
                  </span>
                  {it.unread && <span className="text-[10px] text-sky-400">●</span>}
                  <span className="ml-auto shrink-0 text-xs text-neutral-500">
                    {it.state === 'waiting_approval' ? '승인 대기' : it.state === 'error' ? '오류' : '응답 대기'} ·{' '}
                    {formatWaiting(it.waitingMs)}
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
