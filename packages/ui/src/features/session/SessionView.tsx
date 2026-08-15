import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { shouldCollapseCard, shouldMarkRead, type SessionSummary } from '@cc/core'
import { useStore, type ChatItem } from '../../store/store.js'
import { useFocusedSession } from '../../store/selectors.js'
import { ApprovalCard } from '../approval/ApprovalCard.jsx'
import { Kbd, StateDot } from '../../components/primitives.jsx'

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

  if (!session) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center" data-testid="empty-focus">
        <p className="text-[13px] text-ash">세션을 선택하세요</p>
        <p className="text-[11px] text-slate">
          <Kbd>⌘</Kbd> <Kbd>I</Kbd> 로 기다리는 항목만 모아볼 수 있습니다
        </p>
      </div>
    )
  }

  const ctxPct = session.context ? Math.round((session.context.used / session.context.window) * 100) : null

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-void" data-testid="session-view">
      <header className="flex items-center gap-2.5 border-b border-edge px-4 py-2">
        <StateDot state={session.state} />
        <h1 className="truncate text-[13px] font-medium text-chalk" data-testid="session-name">
          {session.name}
        </h1>

        {ctxPct !== null && (
          <span
            className={`readout ml-1 text-[11px] ${ctxPct >= 80 ? 'text-chalk' : 'text-slate'}`}
            data-testid="context-gauge"
            title={`컨텍스트 ${session.context!.used.toLocaleString()} / ${session.context!.window.toLocaleString()} 토큰`}
          >
            컨텍스트 {ctxPct}%
          </span>
        )}

        {session.limit && (
          <span className="readout text-[11px] text-ash" data-testid="limit-badge">
            한도 {session.limit.usedPercent != null ? `${session.limit.usedPercent}%` : '도달'}
            {session.limit.resumeAt
              ? ` · ${new Date(session.limit.resumeAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 해제`
              : ''}
          </span>
        )}

        {session.state === 'working' && (
          <button
            className="ml-auto rounded px-2 py-0.5 text-[11px] text-slate transition-colors hover:bg-graphite hover:text-chalk"
            onClick={() => void interrupt(session.id)}
            data-testid="interrupt"
          >
            중단
          </button>
        )}
      </header>

      <ChatStream
        scrollRef={scrollRef}
        chat={chat}
        pending={session.pendingApproval}
        sessionId={session.id}
      />

      {/*
        프로세스가 없는 세션 (host 재시작 후). 기록은 남아 있으니 읽을 수는 있다.
        말을 걸기 전에 이어갈 수 있음을 알려준다 — 보낸 뒤에 실패를 알리는 것보다 낫다 (FR-10).
      */}
      {!session.live && !session.archived && <ResumeBar sessionId={session.id} />}

      <form
        className="border-t border-edge px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          const t = text.trim()
          if (!t) return
          setText('')
          void send(session.id, t)
        }}
      >
        <div className="flex items-end gap-2 rounded border border-edge bg-panel px-3 py-2 transition-colors focus-within:border-graphite">
          <textarea
            className="max-h-40 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-chalk placeholder:text-slate focus:outline-none"
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder="메시지를 입력하세요"
            data-testid="prompt-input"
          />
          <button
            className="shrink-0 rounded px-2 py-1 text-[12px] text-ash transition-colors hover:bg-graphite hover:text-chalk disabled:opacity-40"
            disabled={!text.trim()}
            data-testid="send"
          >
            보내기
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-slate">
          <Kbd>Enter</Kbd> 보내기 · <Kbd>⇧</Kbd> <Kbd>Enter</Kbd> 줄바꿈
        </p>
      </form>
    </section>
  )
}

/**
 * 대화 스트림 — 가상 스크롤 (D-1).
 *
 * 세션 하나가 수백 턴이 되면 전부 렌더하는 구조는 버틴다고 해도 스크롤이 끊긴다.
 * 화면에 보이는 것만 그리되, 두 가지를 지킨다:
 *   1. 스트리밍 중 자동으로 바닥에 붙되, **사용자가 위로 올려 읽는 중이면 방해하지 않는다**
 *   2. 승인 카드는 언제나 마지막 항목 — 대기 중인 것을 스크롤로 찾게 하지 않는다
 */
function ChatStream({
  scrollRef,
  chat,
  pending,
  sessionId,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  chat: ChatItem[]
  pending: SessionSummary['pendingApproval']
  sessionId: string
}) {
  const stickToBottom = useRef(true)

  const virtualizer = useVirtualizer({
    count: chat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 12,
    getItemKey: (i) => chat[i]?.seq ?? i,
  })

  // 사용자가 위로 올렸는지 추적 — 올려둔 동안에는 끌어내리지 않는다
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    if (!stickToBottom.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length, pending, scrollRef])

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-4 py-4 text-[13px] leading-relaxed"
      data-testid="chat-stream"
    >
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div
            key={v.key}
            ref={virtualizer.measureElement}
            data-index={v.index}
            className="absolute left-0 top-0 w-full pb-3"
            style={{ transform: `translateY(${v.start}px)` }}
          >
            <ChatRow item={chat[v.index]!} />
          </div>
        ))}
      </div>

      {pending && (
        <ApprovalCard sessionId={sessionId} requestId={pending.requestId} detail={pending.detail} />
      )}
    </div>
  )
}

/** 죽은 세션을 되살리는 줄. 실패하면 왜 안 되는지 알려준다 (조용한 실패 금지) */
function ResumeBar({ sessionId }: { sessionId: string }) {
  const resume = useStore((s) => s.resumeSession)
  const createSession = useStore((s) => s.createSession)
  const projectId = useStore((s) => s.sessions[sessionId]?.projectId)
  const [busy, setBusy] = useState(false)

  return (
    <div
      className="flex items-center gap-3 border-t border-edge bg-panel px-4 py-2"
      data-testid="resume-bar"
    >
      <span className="text-[12px] text-ash">이 세션은 실행 중이 아닙니다. 기록은 남아 있습니다.</span>
      <span className="ml-auto flex items-center gap-1.5">
        <button
          className="rounded border border-edge px-2 py-1 text-[12px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
          disabled={busy}
          data-testid="resume-session"
          onClick={async () => {
            setBusy(true)
            await resume(sessionId)
            setBusy(false)
          }}
        >
          {busy ? '이어가는 중…' : '이어가기'}
        </button>
        <button
          className="rounded px-2 py-1 text-[12px] text-slate transition-colors hover:text-chalk"
          data-testid="resume-new-session"
          onClick={() => projectId && void createSession(projectId)}
        >
          새 세션
        </button>
      </span>
    </div>
  )
}

function ChatRow({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end" data-testid="msg-user">
        <div className="max-w-[75%] rounded-lg rounded-br-sm border border-edge bg-panel px-3 py-2 text-chalk">
          {item.text}
        </div>
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <div className="max-w-[75ch] whitespace-pre-wrap text-chalk/90" data-testid="msg-assistant">
        {item.text}
      </div>
    )
  }
  if (item.kind === 'approval') {
    // 대기 중인 승인은 바로 아래 카드가 보여주므로 로그 줄은 결정 후에만 남긴다
    if (!item.decision) return null
    return (
      <p className="readout text-[11px] text-slate" data-testid="msg-approval-log">
        {item.decision === 'deny' ? '거부함' : '허용함'} · {item.summary}
      </p>
    )
  }
  return <ToolCard item={item} />
}

/** 카드 접힘 정책: 조회성은 접힘, 변경은 펼침 (대화창 가독성의 절반) */
function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(!shouldCollapseCard(item.tool, item.readOnly))
  return (
    <div className="rounded border border-edge bg-panel/60" data-testid="tool-card">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="w-2 shrink-0 text-[9px] text-slate">{open ? '▾' : '▸'}</span>
        <span className="readout shrink-0 text-[11px] text-ash">{item.tool}</span>
        <span className="readout truncate text-[11px] text-slate">{item.title}</span>
        {item.ok === false && <span className="ml-auto shrink-0 text-[11px] text-chalk">실패</span>}
      </button>
      {open && item.result && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap border-t border-edge px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-ash">
          {item.result}
        </pre>
      )}
    </div>
  )
}
