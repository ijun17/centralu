import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode, RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Attachment } from '@cc/protocol'
import { shouldMarkRead, type SessionSummary } from '@cc/core'
import { EMPTY_DRAFT, useStore, type ChatItem, type Draft } from '../../store/store.js'
import { useFocusedSession } from '../../store/selectors.js'
import { ApprovalCard } from '../approval/ApprovalCard.jsx'
import { QuestionCard } from '../approval/QuestionCard.jsx'
import { ChevronIcon, CloseIcon, PlusIcon, RestartIcon, SendIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { Kbd, StateDot } from '../../components/primitives.jsx'
import { DragRegion } from '../../components/DragRegion.jsx'
import { Markdown } from './Markdown.jsx'
import { RunMenu } from './RunMenu.jsx'
import { SessionSettings } from './SessionSettings.jsx'
import { AutocompleteMenu, useAutocomplete, type Suggestion } from './Autocomplete.jsx'
import { onFirstLine, onLastLine, sentMessages, stepHistory } from './history.js'
import { appendPath, readDragPath } from '../files/dragPath.js'
import { decideFollow, isAtBottom, MOVED_UP_SLACK, shouldFollowAgain } from './scroll.js'

/** 입력창이 커질 수 있는 최대 높이. CSS의 max-h-40과 같은 값이어야 한다 */
const COMPOSER_MAX_H = 160

/** 셀렉터가 매번 새 배열을 만들면 zustand 스냅샷이 불안정해져 무한 리렌더가 난다 */
const EMPTY_CHAT: ChatItem[] = []

/**
 * 대화창이 열리자마자 바닥에 자리 잡는 데 쓸 프레임 수 (#31).
 *
 * 가상 스크롤은 줄을 재면서 총 높이를 몇 프레임에 걸쳐 늘린다. 그동안 계속 바닥을
 * 다시 짚어야 한다 — 한 번만 짚으면 재기 전 높이에 멈춰 선다. 30프레임은 넉넉한
 * 상한선일 뿐이고, 사람이 손을 대면 그 즉시 끝난다.
 */
const LANDING_FRAMES = 30

/**
 * 포커스 뷰 — 고른 세션 하나를 전체 폭으로.
 *
 * 세션 화면 자체는 SessionPane이 그린다. 그리드의 격자 칸도 **같은 부품**을 쓴다:
 * 복사본을 두면 모델·권한을 한쪽에서 바꿨을 때 다른 쪽이 옛 값을 들고 있게 된다.
 * 여기서는 "무엇을 보여줄지"만 고르고, 그리는 일은 넘긴다.
 */
export function SessionView() {
  const session = useFocusedSession()
  const projectOnly = useStore((s) => (s.focusedSessionId ? undefined : s.projects[s.focusedProjectId ?? '']))

  if (!session) {
    if (!projectOnly) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center" data-testid="empty-focus">
          <p className="text-[13px] text-ash">Select a project or session</p>
          <p className="text-[11px] text-slate">
            <Kbd mod /> <Kbd>I</Kbd> shows everything waiting on you
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
            Git and files are in the evidence panel on the right, even without a session (<Kbd mod /> <Kbd>B</Kbd>)
          </p>
        </div>
      </section>
    )
  }

  return <SessionPane sessionId={session.id} />
}

/**
 * 세션 하나의 화면 — 머리글·대화·입력창.
 *
 * **포커스 뷰와 그리드가 이걸 같이 쓴다.** 그래서 그리드 칸에서 모델을 바꾸면
 * 사이드바와 포커스 뷰가 곧바로 따라온다: 상태를 복사하지 않고 store 하나만 보기 때문이다.
 *
 * 쓰다 만 글은 이 부품이 아니라 **세션**이 들고 있다. 그래서 화면을 바꿔도 남고,
 * 세션을 바꾸면 따라오지 않는다 — 부품이 들고 있던 시절엔 둘 다 반대였다.
 */
export function SessionPane({
  sessionId,
  headerExtra,
  headerDrag,
}: {
  sessionId: string
  /**
   * 머리글 오른쪽에 덧붙일 버튼 (그리드의 '치우기').
   *
   * 슬롯으로 받는 이유: 그리드가 자기 버튼을 칸 위에 절대좌표로 얹었더니
   * 크기도 높이도 헤더의 버튼들과 따로 놀았다. 같은 줄에 넣으면 정렬을 맞출
   * 필요가 없다 — 애초에 어긋날 수가 없다.
   */
  headerExtra?: ReactNode
  /**
   * 머리글을 **칸을 옮기는 손잡이**로 쓴다 (그리드).
   *
   * 주면 이 머리글은 더 이상 창을 끄는 손잡이가 아니다. 포커스 뷰에서는 머리글이
   * 곧 타이틀바지만 그리드에서는 아니기 때문이다 — 같은 부품이라도 어디에 놓였는지에
   * 따라 머리글의 뜻이 달라진다. 그 차이를 부품이 혼자 짐작하게 두지 않는다.
   */
  headerDrag?: (e: DragEvent<HTMLElement>) => void
}) {
  const session = useStore((s) => s.sessions[sessionId])
  const chat = useStore((s) => s.chat[sessionId] ?? EMPTY_CHAT)
  const send = useStore((s) => s.send)
  const restart = useStore((s) => s.restartSession)
  const markRead = useStore((s) => s.markRead)

  /*
   * 쓰다 만 글은 **세션의 것**이다. 이 부품의 것이 아니다.
   *
   * useState로 들고 있었더니 글이 화면의 그 자리에 붙었다. 포커스 뷰에서 세션을
   * 바꿔도 같은 부품이 재사용되므로 A에 쓰던 글이 B의 입력창에 그대로 앉았고,
   * 그대로 보내면 엉뚱한 세션에 갔다. 반대로 그리드는 화면을 갈아 끼우니
   * 부품이 사라지며 글도 같이 사라졌다 — 같은 원인의 양쪽 증상이다.
   */
  const draft = useStore((s) => s.drafts[sessionId] ?? EMPTY_DRAFT)
  const setDraft = useStore((s) => s.setDraft)

  /*
   * 화살표로 되불러온 옛 메시지 (#38). `at`은 기록에서의 자리, `text`는 지금 보이는 글.
   *
   * **쓰다 만 글 위에 덮어쓰지 않는다.** 되불러오는 동안 입력창은 이 값을 보여주고,
   * 세션의 초안은 손대지 않은 채 그대로 남는다. 그래서 가장 최근 것에서 한 번 더
   * 내려오면 쓰던 글이 그대로 돌아온다 — 초안의 사본을 따로 떠두는 방식이었다면
   * 그 사본과 초안이 어긋나는 날(세션 전환·전송 실패)이 반드시 온다.
   *
   * 부품의 상태인 게 맞다: "기록의 몇 번째를 보고 있나"는 지금 이 순간의 조작이지
   * 세션의 사실이 아니다. 세션이 바뀌면 아래에서 비운다.
   */
  const [recall, setRecall] = useState<{ at: number; text: string } | null>(null)
  const text = recall ? recall.text : draft.text
  const attachments = draft.attachments

  const patchDraft = useCallback(
    (patch: (cur: Draft) => Draft) => {
      setDraft(sessionId, patch(useStore.getState().drafts[sessionId] ?? EMPTY_DRAFT))
    },
    [sessionId, setDraft],
  )
  const setText = useCallback(
    (next: string | ((prev: string) => string)) => {
      // 되불러온 글을 고치는 중이면 그 글을 고친다 — 초안은 여전히 건드리지 않는다
      if (recall) {
        setRecall({ ...recall, text: typeof next === 'function' ? next(recall.text) : next })
        return
      }
      patchDraft((cur) => ({ ...cur, text: typeof next === 'function' ? next(cur.text) : next }))
    },
    [patchDraft, recall],
  )
  const setAttachments = useCallback(
    (next: Attachment[] | ((prev: Attachment[]) => Attachment[])) => {
      patchDraft((cur) => ({
        ...cur,
        attachments: typeof next === 'function' ? next(cur.attachments) : next,
      }))
    },
    [patchDraft],
  )
  const [dragging, setDragging] = useState(false)
  /*
   * Whether the Run menu is open — held here rather than inside it (issue #44).
   *
   * In the grid this header is the handle that moves the panel, and `draggable` reaches
   * everything inside it: press on a menu row, move a few pixels, and the browser drags the
   * panel instead of letting the click land. The header already learned the neighbouring
   * half of this lesson — a `draggable` ancestor is why the whole cell stopped being one.
   */
  const [runOpen, setRunOpen] = useState(false)
  const [caret, setCaret] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
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

  /*
   * 세션이 바뀌면 되불러오기는 없던 일이 된다 (#38).
   *
   * 포커스 뷰는 세션을 바꿔도 이 부품을 그대로 쓴다. 안 비우면 A의 기록에서 꺼낸
   * 글이 B의 입력창에 앉아 있게 되는데, 그건 쓰다 만 글을 세션으로 옮긴 이유
   * 그대로다 — 그대로 보내면 엉뚱한 세션에 간다.
   *
   * 그리기 전에 비운다(layout). effect였다면 한 프레임 동안 남의 말이 보인다.
   */
  useLayoutEffect(() => setRecall(null), [sessionId])

  // 자동완성: `/`는 스킬, `@`는 파일
  const ac = useAutocomplete({
    sessionId,
    projectId: session?.projectId ?? '',
    text,
    caret,
    enabled: !!session && caret >= 0,
    // 오케스트레이터에겐 파일이 없다 — `@`는 세션을 집는다 (프로젝트 없음이 그 표식이다)
    atSource: session && session.projectId === null ? 'sessions' : 'files',
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

  /**
   * 화살표로 보낸 말을 되불러온다 (#38). 기록이 나섰으면 true — 그러면 커서는 안 움직인다.
   *
   * 판단은 history.ts가, 커서 규칙은 여기서. 셋 다 만족해야 기록이 나선다:
   *  - 자동완성이 닫혀 있다 (열려 있으면 화살표는 목록의 것이다 — 부르는 쪽이 이미 걸렀다)
   *  - 고른 글자가 없다 (선택이 있는 화살표는 선택을 푸는 키다)
   *  - 커서가 위 화살표면 첫 줄, 아래 화살표면 마지막 줄에 있다
   *
   * 기록은 그때그때 대화에서 훑는다. 미리 만들어 두면 스트리밍 델타마다 수천 줄을
   * 다시 훑게 되는데, 정작 쓰이는 건 화살표를 누른 순간뿐이다.
   */
  const recallHistory = (el: HTMLTextAreaElement, dir: -1 | 1): boolean => {
    if (el.selectionStart !== el.selectionEnd) return false
    const caret = el.selectionStart
    const onEdge = dir === -1 ? onFirstLine(text, caret) : onLastLine(text, caret)
    if (!onEdge) return false

    const step = stepHistory({ history: sentMessages(chat), at: recall?.at ?? null, dir })
    if (step.kind === 'none') return false

    const next = step.kind === 'draft' ? draft.text : step.text
    setRecall(step.kind === 'draft' ? null : { at: step.at, text: step.text })
    /*
     * 커서는 끝으로. 셸이 그렇게 하고, 한 줄짜리 기록에서는 그 자리가 첫 줄이자
     * 마지막 줄이라 위아래로 계속 넘길 수 있다. 여러 줄짜리를 꺼내면 거기서 멈추는데,
     * 그건 맞는 동작이다 — 그 글을 읽고 고치려고 꺼낸 것이다.
     */
    setCaret(next.length)
    requestAnimationFrame(() => {
      const later = inputRef.current
      if (later) later.setSelectionRange(next.length, next.length)
    })
    return true
  }

  // 스크린샷을 붙여넣는 흐름이 가장 흔하다 (FR-13)
  const takeFiles = async (files: FileList | File[] | null) => {
    if (!files || !session) return
    for (const f of Array.from(files)) {
      const att = await attachFile(session.id, f)
      if (att) setAttachments((prev) => [...prev, att])
    }
  }

  /*
   * 이 칸이 그릴 대화를 이 칸이 챙긴다.
   *
   * 예전엔 focusSession만 기록을 불러왔다. 포커스 뷰에서는 고르는 것과 보는 것이
   * 같은 동작이라 티가 안 났는데, 그리드는 **고르지 않고 보는** 화면이다 —
   * 사이드바에서 한 번도 들어가 본 적 없는 세션을 올리면 빈 칸이 떴다 (도그푸딩).
   * 세션 하나를 그리는 부품이 그 대화를 챙기는 게 맞다.
   */
  const loadHistory = useStore((s) => s.loadHistory)
  const loaded = useStore((s) => !!s.chat[sessionId])
  useEffect(() => {
    if (!loaded) void loadHistory(sessionId)
  }, [sessionId, loaded, loadHistory])

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

  // 세션이 사라지는 순간(삭제·아카이브)에도 그리려 하지 않는다
  if (!session) return null

  const ctxPct = session.context ? Math.round((session.context.used / session.context.window) * 100) : null

  const HEADER = 'flex items-center gap-2.5 border-b border-edge px-4 py-2'
  const header = (
    <>
      <StateDot state={session.state} />
      <h1 className="truncate text-[13px] font-medium text-chalk" data-testid="session-name">
        {session.name}
      </h1>

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
        {/*
          The project's saved shell commands (issue #44). Before restart because it is the
          everyday one — restart is a repair.

          The orchestrator has no project, and with no project there is no directory to run
          in and no terminal to run it in. So it gets no button rather than an empty menu:
          an entry that could never have anything in it is a worse answer than no entry.
        */}
        {session.projectId && (
          <RunMenu
            sessionId={session.id}
            projectId={session.projectId}
            open={runOpen}
            onOpenChange={setRunOpen}
          />
        )}
        {/* 도구가 먹통이 됐을 때 세션을 새로 만들면 맥락이 끊긴다 — 프로세스만 갈아 끼운다 */}
        <IconButton
          label="Restart agent (chat history is kept)"
          onClick={() => void restart(session.id)}
          testId="restart-session"
          align="right"
        >
          <RestartIcon />
        </IconButton>
        {headerExtra}
      </span>
    </>
  )

  return (
    /*
      min-h-0이 없으면 안 된다.
      flex 자식의 min-height 기본값은 auto라 **내용보다 작아지지 못한다.**
      그래서 대화가 길어지면 이 칸이 통째로 늘어나 입력창을 밖으로 밀어냈다
      (그리드에서 칸 높이가 정해져 있으니 곧바로 드러났다 — 입력창이 아예 안 보였다).
    */
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-void" data-testid="session-view">
      {headerDrag ? (
        <div
          className={`${HEADER} cursor-grab active:cursor-grabbing`}
          // Not while the Run menu is open — see the note on `runOpen`
          draggable={!runOpen}
          onDragStart={headerDrag}
          data-testid="pane-header"
        >
          {header}
        </div>
      ) : (
        <DragRegion className={HEADER} testId="pane-header">
          {header}
        </DragRegion>
      )}

      <ChatStream
        scrollRef={scrollRef}
        chat={chat}
        pending={session.pendingApproval}
        questions={session.pendingQuestions}
        sessionId={session.id}
        working={session.state === 'working'}
        activity={session.activity}
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
          /*
            보내고 나면 입력창은 정말로 빈다 (#38).
            되불러오기와 초안을 **둘 다** 비워야 한다 — 하나만 비우면 방금 보낸 자리에
            아까 쓰다 만 글이 되살아난다. 방금 보낸 말은 이제 기록의 맨 위에 있으니
            화살표 한 번이면 다시 꺼낼 수 있다.
          */
          setRecall(null)
          setDraft(session.id, EMPTY_DRAFT)
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
              /*
                한글·일본어·중국어를 조합하는 동안 방향키는 **후보 목록의 키다** —
                가로채면 고르던 글자가 사라진다. 이 입력창에는 조합을 아는 코드가
                하나도 없었으므로(#12) 조용히 틀리기 쉬운 자리다.

                신호를 둘 다 본다: `isComposing`은 표준이고, 브라우저에 따라 조합 중
                눌린 키가 실제 키 대신 `Process`로 온다.
              */
              const composing = e.nativeEvent.isComposing || e.key === 'Process'
              if (!composing && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                if (recallHistory(e.currentTarget, e.key === 'ArrowUp' ? -1 : 1)) {
                  e.preventDefault()
                  return
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
          {/*
            첨부도 보내기와 **같은 부품**을 쓴다. 예전엔 label로 따로 만들어서
            안쪽 여백(6px vs 4px)과 아이콘 크기(16 vs 15)가 달랐고, 나란히 선 두 버튼의
            크기와 높이가 어긋나 보였다 (도그푸딩 지적).
            파일 선택기는 숨긴 input을 눌러 연다 — label 없이도 같은 일을 한다.
          */}
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            data-testid="attach-input"
            onChange={(e) => void takeFiles(e.target.files)}
          />
          <IconButton
            label="Attach file"
            onClick={() => fileRef.current?.click()}
            testId="attach-open"
            placement="top"
            className="shrink-0"
          >
            <PlusIcon size={15} />
          </IconButton>
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
          {/*
            워크트리 세션은 **다른 디렉토리에서 돈다.** 그 사실이 안 보이면 사용자는
            프로젝트 폴더를 열어보고 "왜 파일이 안 바뀌었지"를 겪는다 — 설정 옆에 붙여
            무엇을 어디에 보내는지 한자리에서 읽히게 한다.
          */}
          {session.worktree && (
            <span
              className="readout truncate text-[10px] text-slate"
              title={`Runs in a git worktree: ${session.worktree.path}`}
              data-testid="worktree-badge"
            >
              ⑂ {session.worktree.branch}
            </span>
          )}
          {/*
            컨텍스트도 **쓰는 자리 옆**에 둔다. 대화 머리글에 있을 때는 화면 반대쪽
            끝이라, 길게 쓰는 동안 정작 얼마나 남았는지가 눈에 안 들어왔다 (도그푸딩).

            **모름과 0%를 구별한다.** `context`는 SessionInfo에도 DB에도 없어서
            앱을 껐다 켜면 그 턴이 끝나기 전까지 값이 없다. 그때 0%처럼 보이면
            "아직 하나도 안 썼다"는 거짓말이 된다 — 흐린 `—`는 모른다는 뜻이다.
          */}
          <span
            className={`readout ml-auto shrink-0 text-[11px] ${
              ctxPct === null ? 'text-slate/50' : ctxPct >= 80 ? 'text-chalk' : 'text-slate'
            }`}
            data-testid="context-gauge"
            title={
              session.context
                ? `Context ${session.context.used.toLocaleString()} / ${session.context.window.toLocaleString()} tokens`
                : 'Context unknown — this session has not finished a turn since the app started'
            }
          >
            Context {ctxPct === null ? '—' : `${ctxPct}%`}
          </span>
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
  questions,
  sessionId,
  working,
  activity,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  chat: ChatItem[]
  pending: SessionSummary['pendingApproval']
  questions: SessionSummary['pendingQuestions']
  sessionId: string
  working: boolean
  activity: SessionSummary['activity']
}) {
  /*
   * "Was I at the bottom" is the session's fact, not this component's (issue #31).
   *
   * It stays a ref here because the follow logic reads it from a scroll handler and from
   * effects — re-rendering on it would mean re-rendering on every scroll — but the ref is
   * only a copy. The session holds the original, so a panel that is torn down and built
   * again does not get to decide for itself where you were.
   */
  const stickToBottom = useRef(true)
  const setStickToBottom = useStore((s) => s.setStickToBottom)

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
    // scrollRef는 이 컴포넌트가 **받은 prop**이다 — 안에서 만든 ref와 달리 바뀔 수 있다
  }, [chat, virtualizer, scrollRef])

  /**
   * 우리가 마지막으로 알고 있는 스크롤 위치.
   *
   * "사람이 올렸는가"를 플래그가 아니라 **위치 변화**로 판정하기 위한 기준이다:
   * 내용이 늘어나도 scrollTop은 그대로지만, 사람이 올리면 줄어든다.
   */
  const lastTop = useRef(0)

  // 사용자가 위로 올렸는지 추적 — 올려둔 동안에는 끌어내리지 않는다
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = isAtBottom(el)
    lastTop.current = el.scrollTop
    syncSticky()
  }

  /*
   * A different conversation is not always a new component.
   *
   * The grid throws panels away, but the focus view keeps this one and swaps `sessionId`
   * underneath it — so without this, the refs would carry one conversation's position into
   * the next one. Layout effect, so the flag is in place before the follow effect below
   * reads it on the same commit, and so the cleanup runs while the scroll element is still
   * attached.
   */
  const landed = useRef(false)
  const landing = useRef(0)
  const stillLanding = useRef(false)

  /**
   * The reader has taken the conversation over, so stop arriving at it (#31).
   *
   * Wheel, a hand on the scrollbar, a key: the three ways a person moves this list. It is
   * their intent we are after, not their scroll — `scrollTop` alone cannot tell a wheel
   * from the browser holding the view still while rows measure.
   */
  const endLanding = () => {
    cancelAnimationFrame(landing.current)
    stillLanding.current = false
  }

  useLayoutEffect(() => {
    // Taken now and closed over: this component renders the scroll element and never
    // replaces it, and refs are attached before layout effects run
    const el = scrollRef.current
    stickToBottom.current = useStore.getState().stickToBottom[sessionId] ?? true
    lastTop.current = el?.scrollTop ?? 0
    landed.current = false
    return () => {
      cancelAnimationFrame(landing.current)
      /*
       * Hand the fact back on the way out — not on every scroll event.
       *
       * Arriving is itself a scroll: the position is corrected over several frames while
       * rows measure, and each correction fires an event from somewhere that is not yet
       * the bottom. Letting those speak meant a panel could record "was not at the bottom"
       * about a landing still in progress and then honour that on the way back, which
       * reads as the app losing your place at random (it did, under load).
       *
       * Leaving mid-landing says nothing at all, for the same reason: we never got as far
       * as a position the reader could have held. Whatever the session already believed
       * stands.
       *
       * The element is read here rather than the follow flag because position is the fact.
       * `decideFollow` lets go for reasons of its own when measurements shuffle content,
       * and that is a decision about one frame, not about where the reader was.
       */
      if (el && !stillLanding.current) setStickToBottom(sessionId, isAtBottom(el))
      stillLanding.current = false
    }
  }, [sessionId, scrollRef, setStickToBottom])

  /*
   * Arrive at the bottom, once, and keep going until the bottom stops moving.
   *
   * One `scrollTop = scrollHeight` cannot reach the bottom of a list nobody has measured:
   * rows are 64px guesses until they render, so the number we aim at moves while we aim.
   * The panel came to rest a few hundred pixels short of the end (measured: 339px on an
   * 80-turn conversation) — "the scroll has moved up", which is how #31 was reported.
   *
   * The follow effect below cannot do this job. It has to tell "the content grew" from
   * "the reader scrolled up", and it does that by watching `scrollTop` fall — which is
   * also what happens when rows measure smaller than the guess and the browser clamps us.
   * On a settling list that reads as a person scrolling, so it lets go, a few pixels
   * short, permanently. Here we know nobody has touched anything yet.
   *
   * Nor can it be a matter of waiting for the height to hold still: measuring is deferred
   * to a frame of its own and can arrive several frames late, so "two quiet frames" meant
   * finishing before the list had grown at all — 339px short again, and only sometimes,
   * which is worse than always.
   *
   * Waiting for `chat.length` matters — history arrives after the mount, and there is
   * nothing to land on before it does.
   *
   * If the session was **not** at the bottom we do nothing at all. #31 deliberately does
   * not promise the offset back: restoring one into an unmeasured virtualiser is what put
   * you *near* your place rather than at it. Not moving is the honest version of that —
   * you keep looking at the old messages instead of being dragged to the newest.
   *
   * It ends early two ways: the reader touches the conversation (`endLanding` on the
   * scroller below), or something drags the view up and away from the end. Both are needed.
   * The first catches the wheel before any number has moved; the second catches everything
   * that scrolls without a gesture to announce it.
   */
  useEffect(() => {
    if (landed.current || chat.length === 0) return
    landed.current = true
    if (!stickToBottom.current) return

    let frames = 0
    let mine = -1
    stillLanding.current = true
    const step = () => {
      const el = scrollRef.current
      if (!el) return
      /*
       * Pulled *up* and away from the end — that is somebody else, so stop.
       *
       * Only up counts. When rows above the viewport measure taller than the guess, Chrome
       * moves `scrollTop` down the document by the same amount to hold the view still
       * (scroll anchoring, +32px a frame here); reading any change as a person meant giving
       * up on the third frame, hundreds of pixels short of the end.
       */
      if (mine >= 0 && el.scrollTop < mine - MOVED_UP_SLACK) {
        stillLanding.current = false
        return
      }
      el.scrollTop = el.scrollHeight
      mine = el.scrollTop
      lastTop.current = mine
      if (++frames < LANDING_FRAMES) landing.current = requestAnimationFrame(step)
      else stillLanding.current = false
    }
    landing.current = requestAnimationFrame(step)
    // No cleanup here on purpose: this effect re-runs whenever the conversation grows, and
    // cancelling from there threw the landing away whenever a message arrived first (it
    // did, under load — the panel simply stayed at the top). The frame is cancelled where
    // it actually stops being wanted: when the session changes or the panel goes.
  }, [sessionId, chat.length, scrollRef])

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
    const el = scrollRef.current
    if (!el) return

    /*
     * The landing above is already pinning us every frame, so stay out of its way (#31).
     *
     * Two writers is worse than one here. This one aims once per size change and then asks
     * `decideFollow` whether to let go, and on a list that is still measuring the answer
     * comes back "the reader scrolled up" — which is how the panel ended up a few hundred
     * pixels short of the end and stayed there. Until the landing is done, there is no
     * reader to have scrolled.
     */
    if (stillLanding.current) return

    // 무엇을 할지는 scroll.ts가 정한다 — 여기서는 DOM만 만진다
    const decision = decideFollow({
      sticking: stickToBottom.current,
      scrollTop: el.scrollTop,
      lastTop: lastTop.current,
    })
    if (decision === 'ignore') return
    if (decision === 'release') {
      stickToBottom.current = false
      return
    }

    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
    const id = requestAnimationFrame(() => {
      const later = scrollRef.current
      // 예약할 때의 판단이 아니라 **지금 위치**로 다시 정한다
      if (!later || !shouldFollowAgain(later)) return
      later.scrollTop = later.scrollHeight
      lastTop.current = later.scrollTop
    })
    return () => cancelAnimationFrame(id)
  }, [totalSize, pending, working, scrollRef])

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      /* 사람이 대화에 손을 대면 '바닥으로 자리 잡기'는 거기서 끝난다 (#31) */
      onWheel={endLanding}
      onPointerDown={endLanding}
      onKeyDown={endLanding}
      /* min-h-0: overflow-y-auto가 걸려 있어도 줄어들지 못하면 스스로 늘어난다 */
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-[13px] leading-relaxed"
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

      {/* 선택지는 여러 장이 겹칠 수 있다 — 하나만 그리면 나머지는 답할 길이 없다 */}
      {questions.map((q) => (
        <QuestionCard key={q.requestId} sessionId={sessionId} requestId={q.requestId} questions={q.questions} />
      ))}

      {working && <ActivityRow sessionId={sessionId} activity={activity} />}
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
 *
 * **The count is derived; only the tick lives here** (issue #23). This used to read
 * `Date.now()` on mount and treat that as the start of the turn, which held right up until
 * the component was remounted — switching to the grid and back, or moving between sessions,
 * put a three-minute turn back at zero. The lie was small and in the worst direction: the
 * longer a wait, the more the number understated it.
 *
 * Keeping the component alive would not have been the fix. What was stored was the wrong
 * thing — an elapsed count, which is derived, and derived values should not be the thing
 * that survives. The start instant lives on the store now (`workingSince`), and this
 * subtracts it from the current time. The interval below no longer carries any state; it
 * exists only to make the clock re-read once a second.
 */
function ActivityRow({ sessionId, activity }: { sessionId: string; activity: SessionSummary['activity'] }) {
  const interrupt = useStore((s) => s.interrupt)
  const startedAt = useStore((s) => s.workingSince[sessionId])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // No instant means we genuinely do not know when this turn began — say nothing rather
  // than start a fresh count, which is the mistake this whole row is here to stop making
  const seconds = startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))

  return (
    <div className="flex items-center gap-2 py-2" data-testid="activity-row">
      <span className="size-1.5 animate-pulse rounded-full bg-chalk" aria-hidden />
      {/*
        같은 '대기'가 아니다. 압축은 실측 39초까지 걸렸는데 문구가 같으면
        기다리는 사람은 멈춘 건지 오래 걸리는 건지 판단할 근거가 없다.
      */}
      <span className="text-[12px] text-ash" data-testid="activity-label">
        {activity === 'compacting' ? 'Compacting context' : 'Waiting for response'}
      </span>
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
  const locked = useStore((s) => !!s.wakeLocked[sessionId])
  const wake = useStore((s) => s.wake)
  const fork = useStore((s) => s.forkConversation)

  // 못 깨운 이유가 있으면 그걸 먼저 말한다 — "보내면 이어집니다"는 사실이 아니게 된다
  if (error && !waking) {
    return (
      <p
        className="flex items-center gap-2 border-t border-edge px-4 py-1.5 text-[11px] leading-relaxed text-ash"
        data-testid="dormant-note"
      >
        <span className="min-w-0 flex-1 break-words">Could not resume — {error}</span>
        {/*
          * 다른 쪽이 쥐고 있을 때는 **재시도만으로는 영영 안 열린다** — 사람이 다른 앱을
          * 닫으러 가는 것 말고는 길이 없었다. 갈라서 이어가는 길을 그 자리에 함께 둔다.
          * 원본을 건드리지 않는다는 사실까지 적어야 누르는 것이 무섭지 않다.
          */}
        {locked && (
          <button
            className="shrink-0 rounded border border-edge px-2 py-0.5 text-[11px] text-chalk transition-colors hover:border-graphite"
            onClick={() => void fork(sessionId)}
            title="Continue in a copy of this conversation. The original stays untouched."
            data-testid="dormant-fork"
          >
            Continue in a fork
          </button>
        )}
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
 * **기본은 접힘이다.**
 *
 * 예전엔 조회성만 접고 변경(Bash·Edit·MCP)은 펼쳤다. 변경은 봐야 한다는 생각이었는데,
 * 실제로 써 보니 도구를 몇 번만 써도 대화가 출력으로 뒤덮여 정작 답을 못 읽는다
 * (도그푸딩). 무엇을 했는지는 제목 줄이 이미 말한다 — 명령이든 경로든.
 *
 * 접어도 놓치지 않는 것 둘: 실패는 제목 줄에 'Failed'로 남고,
 * 출력은 맛보기 몇 줄이 그대로 보인다.
 */
function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
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
