import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Attachment } from '@cc/protocol'
import { shouldCollapseCard, shouldMarkRead, type SessionSummary } from '@cc/core'
import { useStore, type ChatItem } from '../../store/store.js'
import { useFocusedSession } from '../../store/selectors.js'
import { ApprovalCard } from '../approval/ApprovalCard.jsx'
import { ChevronIcon, CloseIcon, PlusIcon, RestartIcon, SendIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { Kbd, StateDot } from '../../components/primitives.jsx'
import { DragRegion } from '../../components/DragRegion.jsx'
import { Markdown } from './Markdown.jsx'
import { SessionSettings } from './SessionSettings.jsx'
import { AutocompleteMenu, useAutocomplete, type Suggestion } from './Autocomplete.jsx'
import { appendPath, readDragPath } from '../files/dragPath.js'

/** 입력창이 커질 수 있는 최대 높이. CSS의 max-h-40과 같은 값이어야 한다 */
const COMPOSER_MAX_H = 160

/** 셀렉터가 매번 새 배열을 만들면 zustand 스냅샷이 불안정해져 무한 리렌더가 난다 */
const EMPTY_CHAT: ChatItem[] = []

/** 조작 레인 — 전체 폭 (그리드가 아니라 포커스 뷰인 이유) */
export function SessionView() {
  const session = useFocusedSession()
  const projectOnly = useStore((s) => (s.focusedSessionId ? undefined : s.projects[s.focusedProjectId ?? '']))
  const chat = useStore((s) => (s.focusedSessionId ? (s.chat[s.focusedSessionId] ?? EMPTY_CHAT) : EMPTY_CHAT))
  const send = useStore((s) => s.send)
  const restart = useStore((s) => s.restartSession)
  const markRead = useStore((s) => s.markRead)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [caret, setCaret] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const attachFile = useStore((s) => s.attachFile)
  const scrollRef = useRef<HTMLDivElement>(null)

  /*
   * 입력창 높이는 **값에서** 나온다.
   *
   * 예전엔 onChange에서 직접 style.height를 만졌는데, 그러면 타이핑으로 값이 바뀔 때만
   * 높이가 맞는다. 보내고 나면 setText('')로 값만 비고 높이는 남아서, 빈 입력창이
   * 커진 채로 서 있었다 — 아무것도 안 썼는데 높고, 뭐라도 치면 돌아오는 그 증상이다
   * (도그푸딩 지적). 자동완성으로 긴 경로를 넣을 때는 반대로 안 커졌다.
   *
   * 값이 바뀌는 경로는 앞으로도 늘어난다(붙여넣기·복원·세션 전환…). 경로마다 높이를
   * 다시 맞추는 대신 값 하나만 보게 한다. 페인트 전에 재는 useLayoutEffect라 깜빡이지 않는다.
   */
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_H)}px`
  }, [text])

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
          <p className="text-[13px] text-ash">Select a project or session</p>
          <p className="text-[11px] text-slate">
            <Kbd>⌘</Kbd> <Kbd>I</Kbd> shows everything waiting on you
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
          <p className="text-[13px] text-ash">Select a session or start a new one</p>
          <p className="text-[11px] text-slate">
            Git and files are in the evidence panel on the right, even without a session (<Kbd>⌘</Kbd> <Kbd>B</Kbd>)
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
            title={`Context ${session.context!.used.toLocaleString()} / ${session.context!.window.toLocaleString()} tokens`}
          >
            Context {ctxPct}%
          </span>
        )}

        {session.limit && (
          <span className="readout text-[11px] text-ash" data-testid="limit-badge">
            Limit {session.limit.usedPercent != null ? `${session.limit.usedPercent}%` : 'reached'}
            {session.limit.resumeAt
              ? ` · resets ${new Date(session.limit.resumeAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
              : ''}
          </span>
        )}

        {/*
          중지는 여기 두지 않는다 — 대화 맨 아래 '응답 기다리는 중' 옆에 이미 있다.
          같은 일을 하는 버튼이 화면 양 끝에 하나씩 있으면 어느 쪽이 무엇인지 매번 확인하게 된다.
        */}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {/* 도구가 먹통이 됐을 때 세션을 새로 만들면 맥락이 끊긴다 — 프로세스만 갈아 끼운다 */}
          <IconButton
            label="Restart agent (chat history is kept)"
            onClick={() => void restart(session.id)}
            testId="restart-session"
            align="right"
          >
            <RestartIcon />
          </IconButton>
        </span>
      </DragRegion>

      <ChatStream
        scrollRef={scrollRef}
        chat={chat}
        pending={session.pendingApproval}
        sessionId={session.id}
        working={session.state === 'working'}
      />

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
                {/*
                  이모지를 쓰지 않는다 — OS·폰트마다 생김새가 다르고 대부분 유채색이라
                  "색은 diff 본문에만"이라는 규칙을 곧바로 깬다. 한 글자 기호면 둘 다 없다.
                */}
                <span className="readout text-[9px] text-slate" title={a.kind === 'image' ? 'Image' : 'File'}>
                  {a.kind === 'image' ? 'IMG' : 'DOC'}
                </span>
                <span className="max-w-40 truncate">{a.name}</span>
                <button
                  type="button"
                  className="text-slate transition-colors hover:text-chalk"
                  onClick={() => setAttachments((p) => p.filter((_, j) => j !== i))}
                  aria-label={`Remove attachment ${a.name}`}
                >
                  <CloseIcon size={11} />
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
            // 트리에서 끌어온 경로는 첨부가 아니라 문장에 넣는다.
            // 구분하지 않으면 files가 비어 있어 아무 일도 안 일어난다.
            const path = readDragPath(e.dataTransfer)
            if (path) {
              setText((prev) => {
                const next = appendPath(prev, path)
                // 커서를 끝으로 옮겨야 이어서 칠 수 있다
                requestAnimationFrame(() => {
                  const el = inputRef.current
                  if (!el) return
                  el.focus()
                  el.setSelectionRange(next.length, next.length)
                  setCaret(next.length)
                })
                return next
              })
              return
            }
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
            placeholder="Type a message"
            data-testid="prompt-input"
          />
          <label
            className="flex shrink-0 cursor-pointer items-center justify-center rounded p-1.5 text-slate transition-colors hover:bg-graphite hover:text-chalk"
            title="Attach file"
            aria-label="Attach file"
          >
            <PlusIcon size={16} />
            <input
              type="file"
              multiple
              className="hidden"
              data-testid="attach-input"
              onChange={(e) => void takeFiles(e.target.files)}
            />
          </label>
          <IconButton
            type="submit"
            label="Send (Enter)"
            disabled={!text.trim() && attachments.length === 0}
            testId="send"
            placement="top"
            align="right"
            className="shrink-0 text-ash"
          >
            <SendIcon />
          </IconButton>
        </div>
        {/*
          모델·강도·권한은 **보내기 직전에** 정하는 것들이라 입력창 아래에 둔다.
          헤더에 있을 때는 화면 반대쪽 끝이라, 무엇을 어떤 설정으로 보내는지
          한눈에 같이 보이지 않았다. 여기 있으면 손과 눈이 같은 자리에 머문다.
        */}
        {/*
          단축키 안내는 뺐다. Enter로 보내고 ⇧Enter로 줄을 바꾸는 건 채팅 입력창의
          기본값이라 한 번 배우면 끝인데, 안내는 매번 자리를 차지한다 —
          한 번 읽고 나면 그때부터는 노이즈다 (도그푸딩: "당연한 것들이라").
        */}
        <div className="mt-1.5 flex items-center gap-2">
          <SessionSettings
            sessionId={session.id}
            // 프로젝트 기본값이 아니라 **이 세션의** 도구다 (섞어 쓸 수 있다)
            tool={session.tool}
            model={session.model}
            effort={session.effort}
            preset={session.permissionPreset}
            live={session.live}
          />
        </div>
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
  working,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  chat: ChatItem[]
  pending: SessionSummary['pendingApproval']
  sessionId: string
  working: boolean
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

  /*
   * 지금 화면 위로 지나간 **가장 최근 내 메시지**.
   *
   * position:sticky는 못 쓴다 — 가상 스크롤의 줄들은 absolute로 얹혀 있어서
   * sticky가 걸리지 않는다. 대신 스크롤 위치로 "어느 턴을 보고 있나"를 계산해
   * 목록 위에 한 줄로 띄운다.
   *
   * 렌더된 줄만 보면 화면 밖으로 멀리 밀린 메시지를 놓친다. measurementsCache는
   * 이미 잰 모든 줄의 위치를 갖고 있으므로 그걸 쓴다.
   */
  const [stickyIndex, setStickyIndex] = useState<number | null>(null)

  const syncSticky = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const top = el.scrollTop
    let found: number | null = null
    for (const m of virtualizer.measurementsCache) {
      // 기준은 시작이 아니라 **끝**이다. 줄이 아직 반쯤 보이는데 위에 또 띄우면
      // 같은 말이 두 번 나온다 — 완전히 지나갔을 때만 붙인다.
      if (m.end > top) break // 여기서부터는 아직 화면 안이거나 아래다
      if (chat[m.index]?.kind === 'user') found = m.index
    }
    setStickyIndex(found)
  }, [chat, virtualizer])

  // 사용자가 위로 올렸는지 추적 — 올려둔 동안에는 끌어내리지 않는다
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    syncSticky()
  }

  // 내용이 늘어나면 스크롤 없이도 기준이 달라진다
  useEffect(syncSticky, [syncSticky, chat.length])

  const pinned = stickyIndex !== null ? chat[stickyIndex] : undefined
  const stickyText = pinned?.kind === 'user' ? pinned.text : null

  /*
   * 바닥에 붙어 있으면 계속 따라간다.
   *
   * 기준이 chat.length였는데, 스트리밍 응답은 **항목 수가 안 늘고 마지막 항목이
   * 길어진다.** 그래서 답이 길어지는 동안 화면이 그 자리에 멈춰 있었다
   * (도그푸딩: "맨 아래인데 새 대화가 생겨도 안 따라간다").
   *
   * 가상 스크롤의 총 높이를 보면 두 경우가 한 기준으로 묶인다 — 항목이 늘어도,
   * 있던 항목이 길어져도 총 높이는 바뀐다.
   *
   * 한 번 더 맞추는 이유: 새 줄은 다음 프레임에 측정되므로, 그 전에 잰
   * scrollHeight로 내리면 몇 픽셀 모자란다.
   */
  const totalSize = virtualizer.getTotalSize()
  useEffect(() => {
    if (!stickToBottom.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    const id = requestAnimationFrame(() => {
      if (stickToBottom.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
    return () => cancelAnimationFrame(id)
  }, [totalSize, pending, working, scrollRef])

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 overflow-y-auto px-4 py-4 text-[13px] leading-relaxed"
      data-testid="chat-stream"
    >
      {/*
        지금 보고 있는 턴이 어느 질문에 대한 답인지 — 긴 응답을 읽는 동안
        위로 되돌아가 확인하지 않아도 되게 한 줄로 남긴다.
      */}
      {stickyText !== null && (
        <div className="sticky top-0 z-10 -mx-4 mb-1 px-4" data-testid="sticky-user">
          <div className="truncate rounded border border-slate/30 bg-graphite/95 px-2.5 py-1 text-[11px] text-ash backdrop-blur-sm">
            {stickyText}
          </div>
        </div>
      )}

      <OlderSentinel sessionId={sessionId} scrollRef={scrollRef} />

      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div
            key={v.key}
            ref={virtualizer.measureElement}
            data-index={v.index}
            /*
              턴 경계에 여백을 더 준다. 모든 줄이 같은 간격이면 내 말과 모델의 답이
              한 덩어리로 붙어 보여서, 긴 응답 뒤에 어디서 내 차례가 시작됐는지 못 찾는다.
              내 말 앞은 넓게 띄우고(= 이전 턴과 분리), 뒤는 조금만 띄운다(= 답과 한 묶음).
            */
            className={`absolute left-0 top-0 w-full min-w-0 ${
              chat[v.index]?.kind === 'user' ? 'pb-4 pt-6' : 'pb-3'
            }`}
            style={{ transform: `translateY(${v.start}px)` }}
          >
            <ChatRow item={chat[v.index]!} />
          </div>
        ))}
      </div>

      {pending && (
        <ApprovalCard sessionId={sessionId} requestId={pending.requestId} detail={pending.detail} />
      )}

      {working && <ActivityRow sessionId={sessionId} />}
    </div>
  )
}

/**
 * 답을 기다리는 중이라는 표시.
 *
 * 첫 글자가 나오기까지 수십 초가 걸리는 일이 흔한데, 그동안 화면이 완전히 조용하면
 * **일하는 중인지 멈춘 건지 구분할 방법이 없다** (도그푸딩에서 지적됨).
 *
 * 그래서 두 가지를 같이 보여준다:
 *   - 움직이는 점: "살아 있다". 정지 화면과 구분되는 건 결국 움직임뿐이다.
 *   - 경과 시간: "얼마나 됐나". 3초와 3분은 같은 '대기'가 아니다 —
 *     숫자가 올라가는 걸 보면 멈춘 게 아니라는 것도 같이 알 수 있다.
 *
 * 중지 버튼을 여기에 둔다. 상단에도 있지만, 기다리는 사람의 눈은 대화 맨 아래에 있다.
 */
function ActivityRow({ sessionId }: { sessionId: string }) {
  const interrupt = useStore((s) => s.interrupt)
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    // 마운트 시점이 곧 이 턴이 시작된 시점이다 (working이 아니면 렌더되지 않는다)
    const started = Date.now()
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex items-center gap-2 py-2" data-testid="activity-row">
      <span className="size-1.5 animate-pulse rounded-full bg-chalk" aria-hidden />
      <span className="text-[12px] text-ash">Waiting for response</span>
      {/* 1초짜리 대기에까지 숫자를 띄우면 그냥 소음이다 */}
      {seconds >= 2 && (
        <span className="readout text-[11px] text-slate" data-testid="activity-elapsed">
          {formatElapsed(seconds)}
        </span>
      )}
      <button
        type="button"
        className="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] text-slate transition-colors hover:border-graphite hover:text-chalk"
        onClick={() => void interrupt(sessionId)}
        data-testid="activity-interrupt"
      >
        Stop
      </button>
    </div>
  )
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const min = Math.floor(seconds / 60)
  if (min < 60) return `${min}m ${seconds % 60}s`
  return `${Math.floor(min / 60)}h ${min % 60}m`
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
        {loading ? 'Loading earlier messages…' : 'Scroll up to load more'}
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
  const error = useStore((s) => s.wakeError[sessionId])
  const wake = useStore((s) => s.wake)

  // 못 깨운 이유가 있으면 그걸 먼저 말한다 — "보내면 이어집니다"는 사실이 아니게 된다
  if (error && !waking) {
    return (
      <p
        className="flex items-center gap-2 border-t border-edge px-4 py-1.5 text-[11px] leading-relaxed text-ash"
        data-testid="dormant-note"
      >
        <span className="min-w-0 flex-1 break-words">Could not resume — {error}</span>
        <button
          className="shrink-0 rounded border border-edge px-2 py-0.5 text-[11px] text-chalk transition-colors hover:border-graphite"
          onClick={() => void wake(sessionId)}
          data-testid="dormant-retry"
        >
          Retry
        </button>
      </p>
    )
  }

  return (
    <p className="border-t border-edge px-4 py-1.5 text-[11px] text-slate" data-testid="dormant-note">
      {waking ? 'Waking session…' : 'Dormant — sending a message resumes it automatically'}
    </p>
  )
}

function ChatRow({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end" data-testid="msg-user">
        {/*
          긴 URL·경로처럼 공백 없는 문자열은 기본 규칙으로는 안 끊긴다.
          그러면 말풍선이 가로로 삐져나가 대화창 전체에 가로 스크롤이 생긴다
          (도그푸딩 지적). whitespace-pre-wrap으로 사용자가 친 줄바꿈은 살리고,
          break-words로 못 끊는 긴 덩어리도 끊는다.
        */}
        {/*
          바탕(void #090909)과 대비가 서야 "내가 한 말"이 보인다.
          panel(#121212)+edge(#1e1e1e)로는 두 단계 차이뿐이라 어두운 화면에서 사실상 안 보였다
          (도그푸딩 지적). 호버 배경과 같은 graphite로 올리고 테두리는 한 단계 더 밝게 준다.
        */}
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm border border-slate/40 bg-graphite px-3 py-2 text-chalk">
          {item.text}
        </div>
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <div className="min-w-0" data-testid="msg-assistant">
        <Markdown text={item.text} />
      </div>
    )
  }
  if (item.kind === 'approval') {
    // 대기 중인 승인은 바로 아래 카드가 보여주므로 로그 줄은 결정 후에만 남긴다
    if (!item.decision) return null
    return (
      <p className="readout text-[11px] text-slate" data-testid="msg-approval-log">
        {item.decision === 'deny' ? 'Denied' : 'Allowed'} · {item.summary}
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
        {/* 펼침 표시는 앱 전체에서 하나여야 한다 — 파일 트리와 같은 셰브런 */}
        <span className="shrink-0 text-slate">
          <ChevronIcon open={open} />
        </span>
        <span className="readout shrink-0 text-[11px] text-ash">{item.tool}</span>
        <span className="readout truncate text-[11px] text-slate">{item.title}</span>
        {item.ok === false && <span className="ml-auto shrink-0 text-[11px] text-chalk">Failed</span>}
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
              {hidden} more lines
            </button>
          )}
        </div>
      )}
    </div>
  )
}
