import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Attachment } from '@cc/protocol'
import { shouldCollapseCard, shouldMarkRead, type SessionSummary } from '@cc/core'
import { useStore, type ChatItem } from '../../store/store.js'
import { useFocusedSession } from '../../store/selectors.js'
import { ApprovalCard } from '../approval/ApprovalCard.jsx'
import { Kbd, StateDot } from '../../components/primitives.jsx'
import { DragRegion } from '../../components/DragRegion.jsx'
import { Markdown } from './Markdown.jsx'
import { SessionSettings } from './SessionSettings.jsx'
import { AutocompleteMenu, useAutocomplete, type Suggestion } from './Autocomplete.jsx'

/** 셀렉터가 매번 새 배열을 만들면 zustand 스냅샷이 불안정해져 무한 리렌더가 난다 */
const EMPTY_CHAT: ChatItem[] = []

/** 조작 레인 — 전체 폭 (그리드가 아니라 포커스 뷰인 이유) */
export function SessionView() {
  const session = useFocusedSession()
  const project = useStore((s) => (session ? s.projects[session.projectId] : undefined))
  const projectOnly = useStore((s) => (s.focusedSessionId ? undefined : s.projects[s.focusedProjectId ?? '']))
  const chat = useStore((s) => (s.focusedSessionId ? (s.chat[s.focusedSessionId] ?? EMPTY_CHAT) : EMPTY_CHAT))
  const send = useStore((s) => s.send)
  const interrupt = useStore((s) => s.interrupt)
  const restart = useStore((s) => s.restartSession)
  const markRead = useStore((s) => s.markRead)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [caret, setCaret] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const attachFile = useStore((s) => s.attachFile)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 자동완성: `/`는 스킬, `@`는 파일. 세션이 없으면 입력창 자체가 없다
  const ac = useAutocomplete({
    sessionId: session?.id ?? '',
    projectId: session?.projectId ?? '',
    text,
    caret,
    enabled: !!session && caret >= 0,
  })

  const pick = (item: Suggestion) => {
    const next = ac.apply(item)
    setText(next.text)
    setCaret(next.caret)
    // 값이 반영된 뒤에 커서를 옮겨야 한다 (React가 값을 그린 다음)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  // 스크린샷을 붙여넣는 흐름이 가장 흔하다 (FR-13)
  const takeFiles = async (files: FileList | File[] | null) => {
    if (!files || !session) return
    for (const f of Array.from(files)) {
      const att = await attachFile(session.id, f)
      if (att) setAttachments((prev) => [...prev, att])
    }
  }

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

  // 세션이 없어도 프로젝트를 고르면 깃·파일·뷰어는 볼 수 있다.
  // (이것들은 프로젝트의 속성이지 세션의 속성이 아니다 — 도그푸딩에서 지적됨)
  if (!session) {
    if (!projectOnly) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center" data-testid="empty-focus">
          <p className="text-[13px] text-ash">프로젝트나 세션을 선택하세요</p>
          <p className="text-[11px] text-slate">
            <Kbd>⌘</Kbd> <Kbd>I</Kbd> 로 기다리는 항목만 모아볼 수 있습니다
          </p>
        </div>
      )
    }
    return (
      <section className="flex min-w-0 flex-1 flex-col bg-void" data-testid="project-view">
        <DragRegion className="flex items-center gap-2.5 border-b border-edge px-4 py-2">
          <h1 className="truncate text-[13px] font-medium text-chalk" data-testid="project-view-name">
            {projectOnly.name}
          </h1>
          <span className="readout text-[11px] text-slate">{projectOnly.path}</span>
        </DragRegion>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-[13px] text-ash">세션을 선택하거나 새로 시작하세요</p>
          <p className="text-[11px] text-slate">
            깃·파일은 오른쪽 증거 패널에서 세션 없이도 볼 수 있습니다 (<Kbd>⌘</Kbd> <Kbd>B</Kbd>)
          </p>
        </div>
      </section>
    )
  }

  const ctxPct = session.context ? Math.round((session.context.used / session.context.window) * 100) : null

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-void" data-testid="session-view">
      <DragRegion className="flex items-center gap-2.5 border-b border-edge px-4 py-2">
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

        <span className="ml-auto flex shrink-0 items-center gap-2">
          <SessionSettings
            sessionId={session.id}
            tool={project?.defaultTool ?? 'claude'}
            model={session.model}
            preset={session.permissionPreset}
          />
          {session.state === 'working' && (
            <button
              className="rounded px-2 py-0.5 text-[11px] text-slate transition-colors hover:bg-graphite hover:text-chalk"
              onClick={() => void interrupt(session.id)}
              data-testid="interrupt"
            >
              중단
            </button>
          )}
          {/* 도구가 먹통이 됐을 때 세션을 새로 만들면 맥락이 끊긴다 — 프로세스만 갈아 끼운다 */}
          <button
            className="rounded px-2 py-0.5 text-[11px] text-slate transition-colors hover:bg-graphite hover:text-chalk disabled:opacity-40"
            onClick={() => void restart(session.id)}
            data-testid="restart-session"
            title="에이전트만 다시 시작합니다 (대화 기록은 그대로)"
          >
            새로고침
          </button>
        </span>
      </DragRegion>

      <ChatStream scrollRef={scrollRef} chat={chat} pending={session.pendingApproval} sessionId={session.id} />

      {/*
        프로세스가 없는 세션 (host 재시작 후). 기록은 남아 있으니 읽을 수는 있다.
        말을 걸기 전에 이어갈 수 있음을 알려준다 — 보낸 뒤에 실패를 알리는 것보다 낫다 (FR-10).
      */}
      {!session.live && !session.archived && <DormantNote sessionId={session.id} />}

      <form
        className="border-t border-edge px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          const t = text.trim()
          if (!t && attachments.length === 0) return
          setText('')
          setAttachments([])
          void send(session.id, t, attachments)
        }}
      >
        {attachments.length > 0 && (
          <ul className="mb-1.5 flex flex-wrap gap-1.5" data-testid="attachment-list">
            {attachments.map((a, i) => (
              <li
                key={`${a.path}-${i}`}
                className="flex items-center gap-1.5 rounded border border-edge bg-panel px-2 py-1 text-[11px] text-ash"
              >
                <span className="text-slate">{a.kind === 'image' ? '🖼' : '📄'}</span>
                <span className="max-w-40 truncate">{a.name}</span>
                <button
                  type="button"
                  className="text-slate hover:text-chalk"
                  onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                  aria-label={`${a.name} 첨부 취소`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div
          className={`relative flex items-end gap-2 rounded border bg-panel px-3 py-2 transition-colors focus-within:border-graphite ${
            dragging ? 'border-ash' : 'border-edge'
          }`}
          onDragEnter={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            // 자식으로 들어갈 때도 leave가 오므로 실제로 밖으로 나간 것만 본다
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            void takeFiles(e.dataTransfer.files)
          }}
          data-testid="input-dropzone"
        >
          {ac.open && (
            <AutocompleteMenu
              items={ac.items}
              index={ac.index}
              loading={ac.loading}
              kind={ac.kind}
              onPick={pick}
            />
          )}
          <textarea
            ref={inputRef}
            className="max-h-40 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-chalk placeholder:text-slate focus:outline-none"
            rows={1}
            value={text}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
            }}
            onKeyDown={(e) => {
              // 자동완성이 열려 있으면 방향키·Enter·Tab은 목록의 것이다
              if (ac.open) {
                if (e.key === 'ArrowDown') return e.preventDefault(), ac.move(1)
                if (e.key === 'ArrowUp') return e.preventDefault(), ac.move(-1)
                if (e.key === 'Escape') return e.preventDefault(), setCaret(-1)
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  const item = ac.items[ac.index]
                  if (item) {
                    e.preventDefault()
                    pick(item)
                    return
                  }
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files)
              if (files.length > 0) {
                e.preventDefault()
                void takeFiles(files)
              }
            }}
            placeholder="메시지를 입력하세요"
            data-testid="prompt-input"
          />
          <label
            className="shrink-0 cursor-pointer rounded px-1.5 py-1 text-[12px] text-slate transition-colors hover:bg-graphite hover:text-chalk"
            title="파일 첨부"
          >
            📎
            <input
              type="file"
              multiple
              className="hidden"
              data-testid="attach-input"
              onChange={(e) => void takeFiles(e.target.files)}
            />
          </label>
          <button
            className="shrink-0 rounded px-2 py-1 text-[12px] text-ash transition-colors hover:bg-graphite hover:text-chalk disabled:opacity-40"
            disabled={!text.trim() && attachments.length === 0}
            data-testid="send"
          >
            보내기
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-slate">
          <Kbd>Enter</Kbd> 보내기 · <Kbd>⇧</Kbd> <Kbd>Enter</Kbd> 줄바꿈 · 이미지는 붙여넣기(<Kbd>⌘V</Kbd>)
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
    /*
     * 높이 측정을 다음 프레임으로 미룬다.
     *
     * 기본값(false)이면 ResizeObserver 콜백에서 곧바로 flushSync를 부르는데,
     * React 19가 렌더 도중에 그걸 만나면 경고를 쏟는다
     * (dev 로그에 "flushSync was called from inside a lifecycle method" 8줄).
     * 진짜 오류를 그 소음에 묻히게 두면 안 된다.
     */
    useAnimationFrameWithResizeObserver: true,
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
      <OlderSentinel sessionId={sessionId} scrollRef={scrollRef} />

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

/**
 * 압축된 옛 대화로 거슬러 올라가는 길.
 *
 * 도구가 컨텍스트를 압축해도 **우리 기록은 접히지 않는다** — 모든 메시지는 저장소에 남는다.
 * 접힌 것은 모델의 기억이지 사람의 기록이 아니다.
 *
 * 버튼이 아니라 **위로 스크롤하면 알아서 이어붙인다.** 위로 올리는 행동 자체가
 * 이미 "더 보고 싶다"는 뜻인데, 거기서 버튼을 한 번 더 누르게 할 이유가 없다.
 *
 * 이어붙일 때 **스크롤 위치를 보정한다.** 앞에 내용이 들어가면 보고 있던 줄이
 * 아래로 밀려 내려가는데, 그러면 읽던 자리를 잃고 위로 또 끌어야 한다.
 */
function OlderSentinel({
  sessionId,
  scrollRef,
}: {
  sessionId: string
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const info = useStore((s) => s.history[sessionId])
  const loadOlder = useStore((s) => s.loadOlder)
  const ref = useRef<HTMLDivElement>(null)
  const more = info?.more ?? false
  const loading = info?.loading ?? false

  useEffect(() => {
    const el = ref.current
    const scroller = scrollRef.current
    if (!el || !scroller || !more) return

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || loading) return
        const before = scroller.scrollHeight
        void loadOlder(sessionId).then(() => {
          // 늘어난 만큼 내려서 읽던 자리를 지킨다
          requestAnimationFrame(() => {
            const grew = scroller.scrollHeight - before
            if (grew > 0) scroller.scrollTop += grew
          })
        })
      },
      // 꼭대기에 닿기 조금 전에 미리 채운다 — 멈칫하는 순간이 안 보이게
      { root: scroller, rootMargin: '200px 0px 0px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [sessionId, more, loading, loadOlder, scrollRef])

  if (!more) return null
  return (
    <div ref={ref} className="flex justify-center py-2" data-testid="load-older">
      <span className="readout text-[10px] text-slate">
        {loading ? '이전 대화를 불러오는 중…' : '위로 올리면 더 불러옵니다'}
      </span>
    </div>
  )
}

/**
 * 프로세스가 없는 세션.
 *
 * 예전에는 "이 세션은 실행 중이 아닙니다"라고 막고 [이어가기]를 누르게 했다.
 * 그건 기계 사정을 사람에게 떠넘기는 것이다 — 사람은 이어서 말하고 싶을 뿐이고,
 * 이어갈 수단은 우리가 갖고 있다. 이제 말을 걸면 host가 알아서 되살린다.
 * 여기서는 그 사실만 조용히 알린다 (놀라지 않도록).
 */
function DormantNote({ sessionId }: { sessionId: string }) {
  const waking = useStore((s) => !!s.resuming[sessionId])
  return (
    <p className="border-t border-edge px-4 py-1.5 text-[11px] text-slate" data-testid="dormant-note">
      {waking ? '세션을 깨우는 중…' : '잠들어 있습니다 — 메시지를 보내면 자동으로 이어집니다'}
    </p>
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
      <div data-testid="msg-assistant">
        <Markdown text={item.text} />
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
  if (item.kind === 'mark') {
    return (
      <div className="flex items-center gap-2 py-1" data-testid="msg-mark">
        <span className="h-px flex-1 bg-edge" />
        <span className="readout shrink-0 text-[10px] text-slate">{item.text}</span>
        <span className="h-px flex-1 bg-edge" />
      </div>
    )
  }
  return <ToolCard item={item} />
}

/** 접었을 때 맛보기로 보여줄 줄 수 — 무슨 명령이 뭘 뱉었는지 알아볼 만큼만 */
const PREVIEW_LINES = 3

/**
 * 도구 카드.
 *
 * **안쪽에 스크롤을 두지 않는다.** 대화창 안의 작은 스크롤 영역은 휠을 가로채서,
 * 대화를 넘기려다 카드 안이 굴러가고 대화는 멈춘다 (도그푸딩에서 "불편하다"로 지적됨).
 * 스크롤은 대화창 하나만 갖는다 — 접으면 맛보기, 펴면 전부. 길이는 사람이 정한다.
 *
 * 접힘 기본값: 조회성은 접힘, 변경은 펼침 (대화창 가독성의 절반)
 */
function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(!shouldCollapseCard(item.tool, item.readOnly))
  const lines = item.result ? item.result.replace(/\s+$/, '').split('\n') : []
  const hidden = Math.max(0, lines.length - PREVIEW_LINES)

  return (
    <div className="rounded border border-edge bg-panel/60" data-testid="tool-card">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="tool-card-toggle"
      >
        <span className="w-2 shrink-0 text-[9px] text-slate">{open ? '▾' : '▸'}</span>
        <span className="readout shrink-0 text-[11px] text-ash">{item.tool}</span>
        <span className="readout truncate text-[11px] text-slate">{item.title}</span>
        {item.ok === false && <span className="ml-auto shrink-0 text-[11px] text-chalk">실패</span>}
      </button>

      {lines.length > 0 && (
        <div className="border-t border-edge px-2.5 py-1.5">
          <pre
            className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ash"
            data-testid="tool-card-output"
          >
            {open ? lines.join('\n') : lines.slice(0, PREVIEW_LINES).join('\n')}
          </pre>
          {!open && hidden > 0 && (
            <button
              className="readout mt-1 text-[10px] text-slate transition-colors hover:text-chalk"
              onClick={() => setOpen(true)}
              data-testid="tool-card-more"
            >
              {hidden}줄 더 보기
            </button>
          )}
        </div>
      )}
    </div>
  )
}
