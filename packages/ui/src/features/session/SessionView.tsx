import { useEffect, useRef, useState } from 'react'
import { shouldCollapseCard, shouldMarkRead } from '@cc/core'
import { useStore, type ChatItem } from '../../store/store.js'
import { useFocusedSession } from '../../store/selectors.js'
import { ApprovalCard } from '../approval/ApprovalCard.jsx'
import { StateDot } from '../../components/primitives.jsx'

/** 셀렉터가 매번 새 배열을 만들면 zustand 스냅샷이 불안정해져 무한 리렌더가 난다 */
const EMPTY_CHAT: ChatItem[] = []

/** 조작 레인 — 전체 폭 (그리드가 아니라 포커스 뷰인 이유) */
export function SessionView() {
  const session = useFocusedSession()
  const chat = useStore((s) => (s.focusedSessionId ? (s.chat[s.focusedSessionId] ?? EMPTY_CHAT) : EMPTY_CHAT))
  const send = useStore((s) => s.send)
  const interrupt = useStore((s) => s.interrupt)
  const markRead = useStore((s) => s.markRead)
  const [text, setText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // 읽음 처리: 스크롤 최신 도달 ∥ 포커스 3초 (판정은 core)
  useEffect(() => {
    if (!session) return
    const t = setTimeout(() => {
      const el = scrollRef.current
      const atBottom = el ? el.scrollHeight - el.scrollTop - el.clientHeight < 40 : true
      if (shouldMarkRead({ focused: true, atBottom, focusedForMs: 3000 })) void markRead(session.id)
    }, 3000)
    return () => clearTimeout(t)
  }, [session, chat.length, markRead])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat])

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-500" data-testid="empty-focus">
        세션을 선택하세요 · <kbd className="mx-1">⌘I</kbd> 인박스
      </div>
    )
  }

  const ctxPct = session.context ? Math.round((session.context.used / session.context.window) * 100) : null

  return (
    <section className="flex min-w-0 flex-1 flex-col" data-testid="session-view">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2 text-sm">
        <StateDot state={session.state} />
        <span className="truncate font-medium text-neutral-100" data-testid="session-name">
          {session.name}
        </span>
        {ctxPct !== null && (
          <span
            className={`ml-2 text-xs ${ctxPct >= 80 ? 'text-amber-400' : 'text-neutral-500'}`}
            data-testid="context-gauge"
            title="컨텍스트 사용량"
          >
            ctx {ctxPct}%
          </span>
        )}
        {session.limit && (
          <span className="text-xs text-amber-500" data-testid="limit-badge">
            한도 {session.limit.usedPercent != null ? `${session.limit.usedPercent}%` : ''}
            {session.limit.resumeAt ? ` · ${new Date(session.limit.resumeAt).toLocaleTimeString('ko-KR')} 해제` : ''}
          </span>
        )}
        <button
          className="ml-auto rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800"
          onClick={() => void interrupt(session.id)}
          data-testid="interrupt"
        >
          중단
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-4 text-sm" data-testid="chat-stream">
        {chat.map((item) => (
          <ChatRow key={item.seq} item={item} />
        ))}
        {session.pendingApproval && (
          <ApprovalCard
            sessionId={session.id}
            requestId={session.pendingApproval.requestId}
            detail={session.pendingApproval.detail}
          />
        )}
      </div>

      <form
        className="flex gap-2 border-t border-neutral-800 p-3"
        onSubmit={(e) => {
          e.preventDefault()
          const t = text.trim()
          if (!t) return
          setText('')
          void send(session.id, t)
        }}
      >
        <textarea
          className="min-h-[38px] flex-1 resize-y rounded border border-neutral-700 bg-neutral-900 p-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder="메시지 (Enter 전송, Shift+Enter 줄바꿈)"
          data-testid="prompt-input"
        />
        <button className="rounded bg-neutral-700 px-3 text-sm text-white hover:bg-neutral-600" data-testid="send">
          전송
        </button>
      </form>
    </section>
  )
}

function ChatRow({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <div className="ml-auto max-w-[80%] rounded-lg bg-neutral-800 px-3 py-2 text-neutral-100" data-testid="msg-user">
        {item.text}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <div className="whitespace-pre-wrap text-neutral-200" data-testid="msg-assistant">
        {item.text}
      </div>
    )
  }
  if (item.kind === 'approval') {
    return (
      <div className="text-xs text-neutral-500" data-testid="msg-approval-log">
        승인 {item.decision === 'deny' ? '거부' : item.decision ? '허용' : '대기'}: {item.summary}
      </div>
    )
  }
  return <ToolCard item={item} />
}

/** 카드 접힘 정책: 조회성은 접힘, 변경은 펼침 (대화창 가독성의 절반) */
function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(!shouldCollapseCard(item.tool, item.readOnly))
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-xs" data-testid="tool-card">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <span className="text-neutral-500">{open ? '▾' : '▸'}</span>
        <span className="font-medium text-neutral-300">{item.tool}</span>
        <span className="truncate text-neutral-500">{item.title}</span>
        {item.ok === false && <span className="ml-auto text-rose-400">실패</span>}
      </button>
      {open && item.result && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-neutral-400">{item.result}</pre>
      )}
    </div>
  )
}
