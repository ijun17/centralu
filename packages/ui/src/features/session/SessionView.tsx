import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode, RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { shouldMarkRead, type SessionSummary } from '@cc/core'
import { EMPTY_DRAFT, useStore, type ChatAttachment, type ChatItem, type Draft } from '../../store/store.js'
import { useFocusedSession } from '../../store/selectors.js'
import { ApprovalCard } from '../approval/ApprovalCard.jsx'
import { QuestionCard } from '../approval/QuestionCard.jsx'
import { ChevronIcon, CloseIcon, PlusIcon, RestartIcon, SendIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { Kbd, StateDot } from '../../components/primitives.jsx'
import { Modal } from '../../components/Modal.jsx'
import { DragRegion } from '../../components/DragRegion.jsx'
import { Markdown } from './Markdown.jsx'
import { RunMenu } from './RunMenu.jsx'
import { CommandRunnerOverlay } from './CommandRunner.jsx'
import { SessionSettings } from './SessionSettings.jsx'
import { AutocompleteMenu, useAutocomplete, type Suggestion } from './Autocomplete.jsx'
import { guiCommandFor } from './guiCommands.js'
import { onFirstLine, onLastLine, sentMessages, stepHistory } from './history.js'
import { onFirstVisualLine, onLastVisualLine } from './caret.js'
import { appendPath, readDragPath } from '../files/dragPath.js'
import { anchorAt, decideFollow, isAtBottom, MOVED_UP_SLACK, shouldFollowAgain } from './scroll.js'

/** 입력창이 커질 수 있는 최대 높이. CSS의 max-h-40과 같은 값이어야 한다 */
const COMPOSER_MAX_H = 160

/**
 * 접힌 입력창이 떠오르는 감지 범위 (칸 아래에서부터, px).
 * 내민 카드 머리(14px) + 손이 겨누는 여유 40px — 대화 한복판에서는 안 뜬다.
 */
const COMPOSER_REACH = 54

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
        <div
          className="flex flex-1 flex-col items-center justify-center gap-3 text-center"
          data-testid="empty-focus"
        >
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
            Git and files are in the evidence panel on the right, even without a session (<Kbd mod />{' '}
            <Kbd>B</Kbd>)
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
  fold = false,
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
   * 입력창을 접어 둘까 (그리드, 사용자 요청 2026-09-10).
   *
   * 두 줄짜리 그리드에서 읽는 자리가 좁다는 데서 나왔다 — 칸 370px 중 입력 영역이 95px,
   * 그중 글자를 넣는 칸은 22px뿐이었다. 접으면 **둥근 카드의 윗머리만** 남고, 아래에
   * 손이 오면 대화 위로 떠오른다. 밀지 않고 덮으므로 읽던 줄은 안 움직인다.
   */
  fold?: boolean
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
  /*
   * The directory a path in this conversation would be relative to (#39).
   *
   * It is read from this session rather than from whatever is focused because a grid cell
   * renders this same component for a session that is not the focused one — asking the
   * focused session would resolve one pane's paths against another pane's project. The
   * orchestrator has no project at all and so gets null, which is what stops its messages
   * from linking anywhere (see `parseFileRef`).
   */
  const projectRoot = useStore((s) => {
    const pid = s.sessions[sessionId]?.projectId
    return (pid && s.projects[pid]?.path) || null
  })
  const restart = useStore((s) => s.restartSession)
  // 프로세스를 갈아 끼우는 중인가 (wake·fork와 같은 자물쇠) — 버튼이 돌고 잠기는 근거
  const restarting = useStore((s) => !!s.resuming[sessionId])
  const markRead = useStore((s) => s.markRead)

  /*
   * Whether the Run menu is open — held here rather than inside it (issue #44).
   *
   * In the grid this header is the handle that moves the panel, and `draggable` reaches
   * everything inside it: press on a menu row, move a few pixels, and the browser drags the
   * panel instead of letting the click land. The header already learned the neighbouring
   * half of this lesson — a `draggable` ancestor is why the whole cell stopped being one.
   */
  const [runOpen, setRunOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  /**
   * 접힌 입력창이 떠 있나 (fold일 때만 뜻이 있다).
   *
   * 방아쇠 넷을 **OR로** 묶는다: 아래쪽에 손이 왔거나(hover), **떠오른 카드 위에 손이
   * 있거나**, 입력칸에 포커스가 있거나, 그 줄의 메뉴(모델·권한)가 열려 있거나. 마우스가
   * 떠나도 포커스·메뉴가 살아 있으면 내려가지 않는다 — 쓰는 도중에 발밑이 꺼지면 안 된다.
   *
   * 카드 위 hover가 따로 있어야 하는 이유 (사용자 지적 2026-09-10): 띠(아래 COMPOSER_REACH)는
   * **접혀 있을 때 떠오르게 하는** 자리다. 떠오른 카드는 그 띠보다 위로 올라오므로, 입력칸을
   * 누르러 손을 올리는 순간 띠를 벗어나 카드가 다시 내려갔다 — **누를 수가 없었다.**
   */
  const [nearComposer, setNearComposer] = useState(false)
  const [overComposer, setOverComposer] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const [composerMenu, setComposerMenu] = useState(false)
  const composerUp = !fold || nearComposer || overComposer || composerFocused || composerMenu

  /*
   * 떠오른 카드가 차지하는 높이 — **재서 안다** (사용자 지적 2026-09-13).
   *
   * 상수로 적을 수 없다: 첨부가 붙으면 줄이 하나 생기고, 입력칸은 다섯 줄까지 자란다.
   * 이 값이 곧 대화 아래 여백이 되므로, 어긋나면 그만큼 마지막 줄이 카드 밑에 깔린다.
   */
  const composerRef = useRef<HTMLDivElement>(null)
  const [composerH, setComposerH] = useState(0)
  useLayoutEffect(() => {
    const el = composerRef.current
    if (!fold || !el) return
    const measure = () => setComposerH(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fold])

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

  /*
   * 머리글 높이는 여백이 아니라 **높이로** 적는다 (2026-09-13).
   *
   * 값은 원래대로 40px이다 — 32·36px도 써 봤지만 되돌렸다. 바뀐 것은 적는 방식이다:
   * py-2로 적으면 높이가 안에 든 것 중 가장 큰 것(도구 단추 줄 23px)에 딸려 정해지고,
   * 옆에 선 증거 패널 머리글은 그 안에 든 것이 24px이라 41px로 **1px 어긋나 있었다.**
   * 나란히 선 두 줄은 1px만 달라도 경계가 두 겹으로 보인다. 둘 다 h-10이면 그 차이는
   * 애초에 생기지 않는다.
   */
  const HEADER = 'flex h-10 items-center gap-2.5 border-b border-edge px-4'
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
        걸려 있는 골 (2026-09-07 — claude /goal · codex thread/goal/*). 골이 도는
        세션의 관심사는 "언제 끝나나"라, 조건 전문이 아니라 사실 요약(바퀴 수·상태)을
        달고 전문·미달 사유는 호버에 둔다. 걷히면(달성 포함) 사라진다.
      */}
      {session.goal && (
        <span
          className="readout shrink-0 rounded border border-edge px-1.5 text-[10px] text-ash"
          data-testid="goal-badge"
          title={`${session.goal.objective}${session.goal.reason ? `\n\n${session.goal.reason}` : ''}`}
        >
          GOAL
          {session.goal.iterations != null ? ` · ${session.goal.iterations}` : ''}
          {session.goal.status !== 'active' ? ` · ${session.goal.status}` : ''}
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
        {session.projectId && <RunMenu projectId={session.projectId} open={runOpen} onOpenChange={setRunOpen} />}
        {/* 도구가 먹통이 됐을 때 세션을 새로 만들면 맥락이 끊긴다 — 프로세스만 갈아 끼운다 */}
        {/*
          누르는 동안 **아이콘이 돌고 버튼이 잠긴다.**
          몇 초 걸리는 일인데 화면이 조용하면 한 번 더 누르게 되고, 그 두 번째
          누름은 방금 뜬 프로세스를 다시 죽인다 — 고치려던 버튼이 고장을 만든다.
          잠금은 스토어에 있다(resuming): 그리드↔포커스로 화면이 갈려도 도는 중이라는
          사실은 세션의 것이지 이 부품의 것이 아니다.
        */}
        <IconButton
          label={restarting ? 'Restarting the agent…' : 'Restart agent (chat history is kept)'}
          onClick={() => void restart(session.id)}
          disabled={restarting}
          testId="restart-session"
          align="right"
        >
          <span
            className={restarting ? 'cc-spin block' : 'block'}
            data-testid={restarting ? 'restart-spinning' : undefined}
          >
            <RestartIcon />
          </span>
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
    <section
      /*
       * fold면 **clip이다 (hidden이 아니라).**
       *
       * 접힌 입력창은 칸 밖으로 내려가 있다 — 그건 스크롤 가능한 넘침이다. `overflow:hidden`은
       * 그림만 자를 뿐 상자는 여전히 스크롤 컨테이너라, 브라우저가 밖에 있는 입력칸에 포커스를
       * 주는 순간 **칸을 통째로 밀어 올려** 보여주려 한다 (실측: 칸이 85px 스크롤되어 머리글이
       * 위로 사라지고, 그 사이 눌린 버튼은 mouseup을 못 받아 클릭이 통째로 사라졌다).
       * `clip`은 스크롤 컨테이너를 만들지 않으므로 밀어 올릴 자리가 아예 없다.
       */
      className={`relative flex min-h-0 min-w-0 flex-1 flex-col bg-void ${fold ? 'overflow-clip' : ''}`}
      data-testid="session-view"
      /*
       * 손이 아래쪽에 오면 입력창이 뜬다. 감지는 **가짜 요소가 아니라 좌표로** 한다 —
       * 투명한 감지판을 깔면 그만큼 대화의 글자를 못 고르고 링크도 못 누른다.
       * 띠(14px) 위로 40px까지가 범위다: 겨누기 쉬우면서, 대화 한복판을 지날 땐 안 뜬다.
       */
      onMouseMove={
        fold
          ? (e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setNearComposer(e.clientY > r.bottom - COMPOSER_REACH)
            }
          : undefined
      }
      onMouseLeave={fold ? () => setNearComposer(false) : undefined}
    >
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
        bottomPeek={fold}
        /*
         * **늘** 카드만큼 벌려 둔다 — 떠오를 때 벌리지 않는다 (사용자 지적 2026-09-13).
         *
         * 처음엔 떠 있을 때만 벌렸다(쉴 때 24px). 자리를 아끼는 쪽이 맞아 보였지만, 그건
         * 카드가 떠오르는 순간 **대화가 위로 움직인다**는 뜻이다. 그리고 카드를 떠오르게
         * 하는 손짓은 아래쪽으로 손을 내리는 것 — 즉 질문 카드의 답변 버튼을 누르러 가는
         * 그 동작이다. 누르려고 다가가면 버튼이 위로 달아났다.
         *
         * 움직이는 과녁을 만들지 않는 것이 아끼는 자리보다 비싸다. 그래서 빈 자리는 처음부터
         * 거기 있고, 카드는 그 위에 얹혔다 내려갈 뿐이다 — 대화는 한 픽셀도 안 움직인다.
         */
        bottomPad={fold ? composerH : undefined}
        scrollRef={scrollRef}
        chat={chat}
        pending={session.pendingApproval}
        questions={session.pendingQuestions}
        sessionId={session.id}
        projectRoot={projectRoot}
        working={session.state === 'working'}
        activity={session.activity}
      />

      {/*
        프로세스가 없는 세션 (host 재시작 후). 기록은 남아 있으니 읽을 수는 있다.
        말을 걸기 전에 이어갈 수 있음을 알려준다 — 보낸 뒤에 실패를 알리는 것보다 낫다 (FR-10).
      */}
      {!session.live && <DormantNote sessionId={session.id} />}

      {/*
        접힘 (사용자 요청 2026-09-10): 둥근 카드가 아래에서 윗머리만 내밀고 있다가 떠오른다.
        **글자로 안내하지 않는다** — 둥근 모서리가 위로 올라올 수 있는 카드라고 말한다.

        절대 배치인 것은 그대로다(대화의 레이아웃 높이를 안 건드린다). 다만 **덮지는
        않는다**: 대화 아래에 카드 높이만큼의 빈 자리가 늘 비워져 있고, 카드는 그 자리에
        얹혔다 내려간다 (사용자 지적 2026-09-13). 원래는 "밀지 않고 덮는다"가 미덕이었는데,
        그 미덕의 값이 마지막 몇 줄을 못 읽는 것이었다 — 읽으려고 손을 내린 사람에게 읽을
        것을 가리는 셈이었다. 그렇다고 떠오를 때 밀어 올리는 것도 답이 아니었다: 카드를
        부르는 손짓이 곧 답변 버튼을 누르러 가는 손짓이라, 누르려는 버튼이 달아났다.
      */}
      <div
        className={
          fold
            ? /*
               * 아래 모서리도 둥글다 — 칸과 **같은 반지름**으로 (사용자 지적 2026-09-10).
               * 칸은 rounded-lg로 잘리는데 카드 아래가 각지면 그 곡선에 잘려 테두리가
               * 뾰족하게 끊긴다. 같은 곡선을 그리면 잘릴 것이 없다.
               */
              `absolute inset-x-0 bottom-0 z-20 rounded-t-xl rounded-b-[7px] border border-edge bg-void px-1 pt-1 transition-[translate,box-shadow] duration-300 ease-out motion-reduce:transition-none ${
                composerUp
                  ? /*
                     * 그림자의 일은 **덮고 있는 글과 카드를 떼어 놓는 것**이다. 떠 있을 때
                     * 가장 많이 덮으므로 더 멀리 드리운다 — 짙기는 접힘과 같게 두고
                     * (실측: 칸 바닥 #121212 위에서 둘 다 최저 12), 번지는 거리만 늘린다.
                     * 여기가 25px, 접힘이 18px이다.
                     */
                    'translate-y-0 shadow-[0_-19px_40px_-15px_rgb(0_0_0/0.58)]'
                  : /*
                     * 쉴 때는 **머리만 남긴다** (사용자 지적 2026-09-11: "인풋이 안 보이게").
                     *
                     * 26px을 내놓던 자리다. 실측하면 그 높이는 입력칸의 윗단 9px까지 같이
                     * 보여 준다 — 쉬는 카드가 "비어 있는 입력칸"으로 읽혔다. 아무 일도 없는
                     * 면이 화면에서 가장 말이 많았던 셈이다.
                     *
                     * 지금 내놓는 16px은 **카드 머리에서 입력칸까지의 여백 전부**이고, 딱
                     * 거기까지다 (사용자 지정 2026-09-11): 카드 pt-1 4px + 폼 py-3 12px.
                     * 그 다음 줄이 곧 입력칸의 윗 테두리이므로 이 값은 **입력칸을 숨기면서
                     * 내놓을 수 있는 최댓값**이다 — 1px만 더 올리면 그 테두리가 문턱 위로
                     * 올라온다(실측). 여백 둘 중 하나가 바뀌면 이 숫자도 같이 바뀌어야 한다.
                     *
                     * 입력칸에 bg-panel을 되돌릴 수 있게 된 것도 이 높이 덕이다 — 삐져나와
                     * 칸 바닥에 구멍처럼 보이던 밝은 띠가 이제 없다.
                     *
                     * 이 높이가 손에 안 잡히는 것은 아니다 — 떠오르는 방아쇠는 카드가 아니라
                     * 칸 아랫단의 54px 띠(COMPOSER_REACH)라서, 내놓는 선이 얇아져도 손은 같은
                     * 자리에서 카드를 부른다.
                     *
                     * 바탕은 여전히 칸 바닥과 같은 색이고 테두리도 카드 쪽이 어둡다(edge <
                     * 칸의 graphite). 카드가 거기 있다는 말은 밝기가 아니라 **모양**이 한다.
                     * 그림자는 여기서도 진다 (사용자 지적 2026-09-11). 짧게 드리우되 옅지는
                     * 않다 — 내놓는 선이 16px뿐이라 밝기로는 말할 수 없고, 카드가 칸 위에
                     * **얹혀 있다**는 말은 이 그림자가 혼자 한다.
                     *
                     * 짙기는 눈이 아니라 자로 맞췄다: 칸 바닥이 #121212라 화면에서 검정은
                     * 거의 움직이지 않는다 — 눈금이 열 칸도 안 되는 자다. 픽셀로 재면 바닥
                     * 18 위에서 이 그림자의 가장 어두운 줄이 **12**다. 다섯 번 재서 얻은
                     * 값이다: 12 → 6(너무 짙다) → 9("절반") → 10("살짝만 약하게") → 12
                     * ("진하기를 줄여줘", 사용자 지정 2026-09-12). 한 눈금이 곧 한 번의
                     * 지적이었고, 길어진 뒤에 다시 처음 값으로 돌아왔다 — 짙기의 문제가
                     * 아니라 **짧아서** 눈에 안 찼던 것이다.
                     *
                     * 짙기와 **길이는 따로 논다**. "길게, 진하기는 그대로"(사용자 지정
                     * 2026-09-12)는 흐림을 키우면서 알파를 같이 내려야 지켜진다 — 흐림만
                     * 키우면 같은 먹이 넓게 퍼져 최저값이 함께 옅어지고, 알파만 올리면 짙어진다.
                     * 길이도 같은 식으로 재서 좁혔다: 13px(짧다) → 25px(길다) → **18px**
                     * (둘의 중간, 사용자 지정 2026-09-12). 떠 있을 때는 18 → 32 → 25px.
                     * 최저값은 12로 고정한 채 길이만 움직였다 — 흐림을 줄이면 먹이 좁은
                     * 자리에 몰려 최저값이 짙어지므로, 매번 알파를 같이 내려 12에 되맞춘다.
                     */
                    'translate-y-[calc(100%_-_16px)] shadow-[0_-14px_32px_-12px_rgb(0_0_0/0.6)]'
              }`
            : undefined
        }
        ref={composerRef}
        data-testid="composer-shell"
        data-up={fold ? composerUp || undefined : undefined}
        onMouseEnter={fold ? () => setOverComposer(true) : undefined}
        onMouseLeave={fold ? () => setOverComposer(false) : undefined}
        onFocusCapture={fold ? () => setComposerFocused(true) : undefined}
        onBlurCapture={
          fold
            ? (e) => {
                // 같은 상자 안으로 옮겨간 포커스는 떠난 것이 아니다 (첨부 버튼 ↔ 입력칸)
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setComposerFocused(false)
              }
            : undefined
        }
      >
        <Composer
          sessionId={session.id}
          framed={!fold}
          onMenuOpenChange={fold ? setComposerMenu : undefined}
        />
      </div>

      {/* 자주 쓰는 명령어 창 (#60) — 칸 안에 뜬다. 그리드 칸이면 그 칸 크기의 창이다 */}
      {runOpen && session.projectId && (
        <CommandRunnerOverlay projectId={session.projectId} onClose={() => setRunOpen(false)} />
      )}
    </section>
  )
}

/**
 * 입력창 (FR-7).
 *
 * **따로 선 부품인 이유는 오직 하나, 초안이 전역 스토어에 있기 때문이다.**
 * 쓰다 만 글은 세션의 것이라 스토어에 있어야 하고(아래 draft 주석), 그러면 한 글자마다
 * 스토어가 바뀐다. 이 코드가 SessionPane 안에 있던 동안에는
 * 그 한 글자가 **머리글·대화 스트림·화면에 보이는 모든 말풍선**을 다시 그렸다
 * (실측: pane=1.0 stream=1.0 row=2.0 렌더/글자, 답변이 흐르는 중에는 두 배).
 * 대화의 크기에 비례하는 비용을 타이핑이 낼 이유가 없다.
 *
 * 그래서 초안을 읽는 자리를 여기 하나로 좁혔다. 위에서는 이제 `sessionId`만 내려온다.
 *
 * 대화(chat)를 구독하지 않는 것도 같은 이유다 — 필요한 곳은 화살표 되불러오기
 * 한 곳뿐이고, 거기서는 누른 그 순간에 getState()로 훑는다. 구독했다면 스트리밍
 * 델타마다 입력창이 다시 그려져 방금 옮긴 비용이 그대로 돌아온다.
 */
const Composer = memo(function Composer({
  sessionId,
  onMenuOpenChange,
  framed = true,
}: {
  sessionId: string
  /** 아래 줄의 메뉴가 열렸나 — 접힌 입력창이 그동안 안 내려가야 한다 (fold) */
  onMenuOpenChange?: (open: boolean) => void
  /**
   * 자기 윗선을 그을 것인가.
   *
   * 대화 바로 아래에 붙어 있을 때는 그 선이 **대화와 입력창의 경계**다. 하지만 접힌
   * 카드 안에서는 카드의 둥근 테두리가 이미 경계고, 그 바로 아래에 직선이 하나 더 그이면
   * 모서리가 두 번 끝나는 것처럼 보인다 (사용자 지적 2026-09-10).
   */
  framed?: boolean
}) {
  /*
   * 세션에서 **여기 정말로 필요한 것만** 집는다.
   *
   * 세션 객체를 통째로 구독하면 답변이 흐르는 동안 델타마다 입력창 전체(첨부 목록·
   * 자동완성 메뉴까지)가 다시 그려진다 — 정작 이 부품이 세션에서 읽는 것은 셋뿐이고,
   * 셋 다 대화 중에 바뀌지 않는 값이다. 모델·권한·컨텍스트처럼 실제로 변하는 것들은
   * 아래 ComposerFooter가 따로 구독한다.
   */
  const alive = useStore((s) => !!s.sessions[sessionId])
  const projectId = useStore((s) => s.sessions[sessionId]?.projectId ?? '')
  const isOrchestrator = useStore((s) => s.sessions[sessionId]?.kind === 'orchestrator')
  const send = useStore((s) => s.send)
  const wake = useStore((s) => s.wake)
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
    (next: ChatAttachment[] | ((prev: ChatAttachment[]) => ChatAttachment[])) => {
      patchDraft((cur) => ({
        ...cur,
        attachments: typeof next === 'function' ? next(cur.attachments) : next,
      }))
    },
    [patchDraft],
  )
  const [dragging, setDragging] = useState(false)
  const [caret, setCaret] = useState(0)
  /*
   * Whether an IME is mid-composition (issue #12).
   *
   * This is the same fact #38 already reads off a `keydown`, held for longer. A key event can
   * only answer "is this keystroke the IME's"; the question here is "is the value in the box
   * finished", and that spans every event between `compositionstart` and `compositionend` —
   * a dozen of them for five Korean syllables.
   *
   * It gates autocomplete and nothing else. `한` arrives as `ㅎ`, `하`, `한`, and with `@` in
   * front each of those is an `fs.search` for a query the person never asked for. The text is
   * deliberately *not* gated: a composing character has to appear as it is typed, so the store
   * write behind `value` stays on every event, and so does the height measurement that keeps
   * that character from being clipped.
   *
   * Note this is not a claim about latency. It removes work; whether that is visible was never
   * measured (see the investigation on #12, which could not separate render cost from the
   * frame it was waiting for).
   */
  const [composing, setComposing] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const attachFile = useStore((s) => s.attachFile)
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
    projectId,
    text,
    caret,
    // Not while composing (#12) — a half-formed syllable is not a query. Closing the menu also
    // hands the arrow keys back: the branch below that spends them on the list is behind `open`.
    enabled: alive && caret >= 0 && !composing,
    // 오케스트레이터의 `@`는 세션을 집는다 — 지시의 대상이 파일이 아니라 세션이다.
    // 판정은 명시적 표식(kind)으로 한다: 오케스트레이터에게는 고를 파일 트리가 없다
    atSource: isOrchestrator ? 'sessions' : 'files',
  })

  const pick = (item: Suggestion) => {
    /*
     * GUI 커맨드 (2026-09-07): 목록에서 고르는 순간이 곧 실행이다 — '/usage'를
     * 입력창에 채워 넣고 엔터를 한 번 더 요구하면, "엔터 치면 화면이 뜬다"는
     * 약속이 두 번의 엔터가 된다. 글은 지우고 화면을 연다.
     */
    // 세션 커맨드 값은 뒤에 공백이 붙는다 — 같은 이름의 진짜 스킬을 골랐을 땐 가로채지 않는다
    const gui = item.value.endsWith(' ') ? null : guiCommandFor(item.value)
    if (gui) {
      setRecall(null)
      setDraft(sessionId, EMPTY_DRAFT)
      gui.run({ sessionId })
      return
    }
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
   *  - 커서가 위 화살표면 첫 줄, 아래 화살표면 마지막 줄에 있다 — **접힌 줄까지 세어서**
   *
   * 기록은 그때그때 대화에서 훑는다. 미리 만들어 두면 스트리밍 델타마다 수천 줄을
   * 다시 훑게 되는데, 정작 쓰이는 건 화살표를 누른 순간뿐이다.
   */
  const recallHistory = (el: HTMLTextAreaElement, dir: -1 | 1): boolean => {
    if (el.selectionStart !== el.selectionEnd) return false
    const caret = el.selectionStart
    /*
     * 개행으로 먼저 걸러 낸다(값 비교, 공짜). 거기서 걸리지 않은 것만 거울로 잰다 —
     * 긴 한 줄이 접혀 있으면 개행은 없어도 눈에는 여러 줄이고, 그 가운데에서 누른
     * 화살표는 기록이 아니라 커서의 것이다 (사용자 지적 2026-09-07).
     */
    const onEdge =
      dir === -1
        ? onFirstLine(text, caret) && onFirstVisualLine(el)
        : onLastLine(text, caret) && onLastVisualLine(el)
    if (!onEdge) return false

    const step = stepHistory({
      history: sentMessages(useStore.getState().chat[sessionId] ?? EMPTY_CHAT),
      at: recall?.at ?? null,
      dir,
    })
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
    if (!files || !alive) return
    for (const f of Array.from(files)) {
      const att = await attachFile(sessionId, f)
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

  // 세션이 사라지는 순간(삭제·아카이브)에도 그리려 하지 않는다 — 훅이 모두 돈 뒤에 판단한다
  if (!alive) return null

  return (
    <form
      className={`px-4 py-3 ${framed ? 'border-t border-edge' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        const t = text.trim()
        if (!t && attachments.length === 0) return
        /*
          GUI 커맨드 (2026-09-07): `/usage` 같은 이름은 세션에 보낼 응답이 프로토콜에
          없다 — 엔터가 메시지 대신 앱 화면을 연다. 첨부가 있으면 가로채지 않는다:
          무언가를 붙였다는 것은 세션에게 말하는 중이라는 뜻이다.
        */
        const gui = attachments.length === 0 ? guiCommandFor(t) : null
        if (gui) {
          setRecall(null)
          setDraft(sessionId, EMPTY_DRAFT)
          gui.run({ sessionId })
          return
        }
        /*
            보내고 나면 입력창은 정말로 빈다 (#38).
            되불러오기와 초안을 **둘 다** 비워야 한다 — 하나만 비우면 방금 보낸 자리에
            아까 쓰다 만 글이 되살아난다. 방금 보낸 말은 이제 기록의 맨 위에 있으니
            화살표 한 번이면 다시 꺼낼 수 있다.
          */
        setRecall(null)
        setDraft(sessionId, EMPTY_DRAFT)
        void send(sessionId, t, attachments)
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
        /*
         * 입력칸은 다시 **채워진다** (사용자 지적 2026-09-11).
         *
         * 09-10에 비웠던 이유는 "가만히 있는 입력칸이 대화보다 밝다"였다. 그 진단은 카드가
         * 접힐 때 panel 한 줄이 칸 바닥 위로 삐져나와 구멍처럼 보이던 것과 겹쳐 있었는데,
         * 접힘 높이를 낮춰 입력칸 자체가 숨는 지금은 그 부작용이 없다. 남는 것은 원래의
         * 쓸모뿐이다: 글을 치는 면은 글을 읽는 면과 **다른 면**이어야 한다.
         *
         * 밝아지는 것이 지금 일어나는 일이라는 규칙은 테두리가 계속 지킨다 — 포커스면
         * graphite, 파일을 끌어오면 ash.
         */
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
          /*
              Focusing here wakes the session, exactly as selecting it in the sidebar does
              (focusSession → wake). This second call site exists because two paths reach a
              composer without ever selecting: a grid panel's input, and the session a
              restart restored into focus. Both sat asleep until send — so the seconds a
              resume takes ran after the send button instead of during the typing, and the
              slash list could only answer from the disk cache (which kept serving an
              uninstalled plugin's commands). wake() dedups and stays quiet, so a second
              call on an already-live session costs nothing.
            */
          onFocus={() => void wake(sessionId)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
          }}
          onKeyDown={(e) => {
            // 자동완성이 열려 있으면 방향키·Enter·Tab은 목록의 것이다
            if (ac.open) {
              if (e.key === 'ArrowDown') return (e.preventDefault(), ac.move(1))
              if (e.key === 'ArrowUp') return (e.preventDefault(), ac.move(-1))
              if (e.key === 'Escape') return (e.preventDefault(), setCaret(-1))
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
                While an IME is composing, Enter and the arrows belong to **the candidate list**,
                not to us (#38, #12). The arrows move through candidates; Enter commits the
                syllable being formed. Enter is the worse one to take: our answer to Enter is to
                send, so the keystroke that was meant to finish a word posts a half-written
                message instead — and Korean needs that keystroke far more often than English,
                which is the shape of "this only happens in Korean".

                This reads the key event rather than the `composing` state above, on purpose. The
                state answers "is the value still forming", which is the right question for
                autocomplete and the wrong one for a keystroke: it is set from an event that in
                principle might not arrive, and a stuck `true` there would mean a message that
                cannot be sent at all. These flags are scoped to this one key and cannot go stale.
                Both are read because `isComposing` is the standard signal and some browsers
                report the key itself as `Process` instead.
              */
            const composingKey = e.nativeEvent.isComposing || e.key === 'Process'
            if (!composingKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              if (recallHistory(e.currentTarget, e.key === 'ArrowUp' ? -1 : 1)) {
                e.preventDefault()
                return
              }
            }
            if (!composingKey && e.key === 'Enter' && !e.shiftKey) {
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
      <ComposerFooter sessionId={sessionId} onMenuOpenChange={onMenuOpenChange} />
    </form>
  )
})

/**
 * 입력창 아래 줄 — 모델·강도·권한, 워크트리, 컨텍스트.
 *
 * 입력창과 **따로 구독하는 이유**: 여기 있는 값들은 대화 중에 계속 바뀌고(컨텍스트는
 * 턴마다, live는 재시작마다), 입력창은 그 변화와 아무 상관이 없다. 한 부품이었을 때는
 * 답변이 흐르는 동안 델타마다 textarea까지 통째로 다시 그려졌다.
 *
 * 자리가 여기인 것은 그대로다 — 모델·권한은 **보내기 직전에** 정하는 것들이라
 * 헤더(화면 반대쪽 끝)가 아니라 손과 눈이 머무는 이 자리에 있어야 한다.
 */
const ComposerFooter = memo(function ComposerFooter({
  sessionId,
  onMenuOpenChange,
}: {
  sessionId: string
  onMenuOpenChange?: (open: boolean) => void
}) {
  const session = useStore((s) => s.sessions[sessionId])
  if (!session) return null
  const ctxPct = session.context ? Math.round((session.context.used / session.context.window) * 100) : null
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <SessionSettings
        sessionId={session.id}
        // 프로젝트 기본값이 아니라 **이 세션의** 도구다 (섞어 쓸 수 있다)
        tool={session.tool}
        model={session.model}
        effort={session.effort}
        verbosity={session.verbosity}
        serviceTier={session.serviceTier}
        preset={session.permissionPreset}
        live={session.live}
        onOpenChange={onMenuOpenChange}
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

          **모름과 0%를 구별한다.** 한 번도 턴을 끝낸 적 없는 세션에는 값이 없다.
          그때 0%처럼 보이면 "아직 하나도 안 썼다"는 거짓말이 된다 — 흐린 `—`는
          모른다는 뜻이다.

          (#48 전에는 재시작한 세션도 여기 걸렸다. `context`가 DB에 없어서 앱을
          껐다 켜면 값이 사라졌기 때문이다. 지금은 저장되므로 빈칸은 정말로
          "아직 한 번도 보고된 적 없음"만 뜻한다.)
        */}
      <span
        className={`readout ml-auto shrink-0 text-[11px] ${
          ctxPct === null ? 'text-slate/50' : ctxPct >= 80 ? 'text-chalk' : 'text-slate'
        }`}
        data-testid="context-gauge"
        title={
          session.context
            ? `Context ${session.context.used.toLocaleString()} / ${session.context.window.toLocaleString()} tokens`
            : 'Context unknown — this session has never reported one'
        }
      >
        Context {ctxPct === null ? '—' : `${ctxPct}%`}
      </span>
    </div>
  )
})

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
  projectRoot,
  working,
  activity,
  bottomPeek = false,
  bottomPad,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  chat: ChatItem[]
  pending: SessionSummary['pendingApproval']
  questions: SessionSummary['pendingQuestions']
  sessionId: string
  projectRoot: string | null
  working: boolean
  activity: SessionSummary['activity']
  /** 접힌 입력창이 아래를 조금 가린다 — 마지막 줄이 그 밑에 영영 깔리지 않게 여백을 준다 */
  bottomPeek?: boolean
  /**
   * 떠오른 입력 카드의 높이 (px). 주면 아래 여백이 **그 카드만큼** 벌어진다.
   *
   * 접힘은 원래 "밀지 않고 덮는다"였다 — 떠오를 때 읽던 줄이 안 움직이는 게 미덕이라고
   * 봤기 때문이다. 실제로 써 보니 그 미덕의 값이 **마지막 몇 줄을 못 읽는 것**이었다
   * (사용자 지적 2026-09-13: "올라올 때 대화를 가려서 불편하다"). 그래서 덮는 대신
   * 밀어 올린다. 값이 카드 높이와 같아야 하므로 상수가 아니라 실측치를 받는다 — 첨부가
   * 붙거나 입력칸이 여러 줄이 되면 카드가 자란다.
   */
  bottomPad?: number
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
  // 바닥이 아닌 자리는 줄(seq)로 남는다 (#61) — 픽셀이 아니라 줄이라야 측정을 넘어 살아남는다
  const setScrollAnchor = useStore((s) => s.setScrollAnchor)

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

  /**
   * 지금 화면 맨 위에 걸친 줄 (#61) — **떠날 때가 아니라 움직일 때마다** 갱신한다.
   *
   * 떠나는 순간에 계산하려다 실패했다: 포커스 뷰는 컴포넌트를 그대로 두고 sessionId만
   * 갈아 끼우는데, React는 **새 세션으로 렌더한 뒤에** 정리 함수를 돌린다. 그 시점에
   * 손에 잡히는 대화와 측정값은 이미 다음 세션의 것이라, 떠나는 세션의 자리를 물을
   * 상대가 없다 (e2e가 3,959px 어긋남으로 잡았다).
   *
   * 그래서 사실을 미리 손에 들고 있는다. ref라 다시 그리지 않고, 스크롤 핸들러는
   * 어차피 syncSticky로 이미 한 바퀴 돌고 있으므로 이진 탐색 하나가 더해질 뿐이다.
   */
  const anchor = useRef<{ seq: number; offset: number } | null>(null)

  /**
   * 스크롤이 실제로 일어난 순간에 잰 "바닥이었나" (#61).
   *
   * `stickToBottom`과 갈라놓는 이유가 둘이다. 하나는 위 anchor와 같다 — 정리 함수가
   * 도는 시점의 요소는 이미 다음 세션의 것이라 거기서 재면 안 된다. 다른 하나는
   * 원래 주석이 "따라가기 플래그 말고 위치를 봐라"라고 한 그 이유다: 아래 follow
   * 효과의 release는 줄이 재어지며 내용이 밀릴 때도 플래그를 내리는데, 그건 한
   * 프레임에 대한 판단이지 사람이 어디를 보고 있었나에 대한 답이 아니다.
   * 그래서 **여기서만** 쓰이고, 스크롤 이벤트에서만 적힌다.
   */
  const wasAtBottom = useRef(true)

  // 사용자가 위로 올렸는지 추적 — 올려둔 동안에는 끌어내리지 않는다
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = isAtBottom(el)
    wasAtBottom.current = stickToBottom.current
    lastTop.current = el.scrollTop
    /*
     * 착지 중에는 기억하지 않는다. 그 스크롤은 사람이 아니라 우리가 낸 것이고,
     * 중간 프레임의 자리를 "읽던 자리"로 적어두면 다음 도착이 거기로 간다.
     */
    if (!stillLanding.current) anchor.current = anchorAt(el.scrollTop, virtualizer.measurementsCache, chat)
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

  /*
   * 정리 함수는 **떠나는 순간의** 대화와 측정값을 봐야 한다 (#61).
   *
   * 효과는 sessionId가 바뀔 때만 도는데, 그 클로저가 잡은 chat은 마운트 시점의
   * 것이다 — 그걸로 앵커를 계산하면 그동안 자란 대화가 통째로 빠진 채 엉뚱한 줄을
   * 가리킨다. 의존성에 chat을 넣는 방법은 더 나쁘다: 대화가 자랄 때마다 효과가
   * 다시 돌면서 착지가 매번 처음부터 시작한다. 그래서 값이 아니라 창구를 넘긴다.
   */
  const chatRef = useRef(chat)
  chatRef.current = chat
  const virtRef = useRef(virtualizer)
  virtRef.current = virtualizer

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
    setSettling(false)
  }

  /**
   * 자리를 잡는 동안에는 **보여주지 않는다** (#61).
   *
   * 착지도 복원도 한 프레임에 끝나지 않는다 — 줄을 재는 동안 목표가 움직여서
   * 프레임마다 다시 겨눠야 한다. 그 중간 위치들이 그대로 그려진 것이 "맨 아래에
   * 붙어 있어도 조금 위에서 시작해 아래로 미끄러진다"는 증상이었다. 고칠 것은
   * 겨누는 횟수가 아니라 **중간 과정을 보여주는 것** 자체다.
   *
   * `visibility: hidden`이어야 한다 (display:none이 아니라). 가상 스크롤은 그리는
   * 동안 줄을 재는데, 레이아웃 박스가 사라지면 잴 것이 없어져서 영원히 자리를
   * 못 잡는다. 숨긴 채로도 재고 있다가, 자리가 정해지면 그때 나타난다.
   *
   * 목표에 닿는 순간 바로 보여준다 — 루프는 그 뒤로도 몇 프레임 더 붙잡고 있지만,
   * 이미 제자리이므로 더 움직이는 것은 눈에 보이지 않는다.
   */
  const [settling, setSettling] = useState(false)

  useLayoutEffect(() => {
    // Taken now and closed over: this component renders the scroll element and never
    // replaces it, and refs are attached before layout effects run
    const el = scrollRef.current
    stickToBottom.current = useStore.getState().stickToBottom[sessionId] ?? true
    wasAtBottom.current = stickToBottom.current
    lastTop.current = el?.scrollTop ?? 0
    landed.current = false
    // 앞 세션에서 들고 있던 자리는 여기서 놓는다 — 안 놓으면 다음 이탈이 남의 줄을 적는다
    anchor.current = null
    return () => {
      cancelAnimationFrame(landing.current)
      /*
       * 떠나면서 **보고 있던 줄**을 남긴다 (#61).
       *
       * 여기서 남기는 것이 없던 시절, 바닥이 아닌 자리는 통째로 잊혔다 — 돌아오면
       * 착지 루프는 (바닥이 아니므로) 아무것도 하지 않고, 브라우저는 새 요소를
       * scrollTop 0에서 시작하니 결과가 "맨 위로 튐"이었다. 위치를 안 쓴다는 결정은
       * 픽셀에 대한 것이었는데, 그게 "줄도 안 쓴다"로 넘어가 있었다.
       *
       * 착지 중이면 남기지 않는다 — 아래 setStickToBottom과 같은 이유다. 아직
       * 사람이 가질 수 있었던 자리가 아니다.
       */
      /*
       * 손에 들고 있던 자리를 그대로 넘긴다 — 여기서 새로 계산하지 않는다 (위 anchor 주석).
       *
       * 바닥이었는지도 el이 아니라 ref로 판정한다. 같은 이유다: 세션 전환에서 이
       * 정리 함수가 도는 시점의 el은 **다음 세션의 대화를 담은** 같은 요소라,
       * 거기서 잰 "바닥인가"는 떠나는 세션에 대한 답이 아니다. 두 ref 모두 스크롤이
       * 실제로 일어난 순간에 적힌 값이다.
       */
      if (el && !stillLanding.current) {
        setScrollAnchor(sessionId, wasAtBottom.current ? null : anchor.current)
      }
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
       * The element is not read here (it was, until #61): by the time this runs on a
       * session switch the same element already holds the *next* conversation, so it
       * answers about the wrong session — it reported "at the bottom" for a session left
       * halfway up, and the anchor saved beside it was then never consulted. `wasAtBottom`
       * is the same fact taken at the only moment it is true: when the reader scrolled.
       * (Still not the follow flag, for the reason its own comment gives.)
       */
      if (el && !stillLanding.current) setStickToBottom(sessionId, wasAtBottom.current)
      stillLanding.current = false
    }
    // chat/virtualizer는 ref로 읽는다 (위 chatRef 주석) — 의존성에 넣으면 대화가
    // 자랄 때마다 이 효과가 다시 돌면서 착지가 매번 처음부터 시작한다
  }, [sessionId, scrollRef, setStickToBottom, setScrollAnchor])

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

    /*
     * 바닥이 아니었다면 **남겨둔 줄로 돌아간다** (#61).
     *
     * 예전엔 여기서 그냥 return이었고, 그게 "돌아오면 맨 위" 버그의 전부였다.
     * 착지와 같은 문제를 풀지만 과녁이 다르다: 바닥은 재지 않아도 닿지만, 줄은
     * 그 위의 모든 줄을 재야 자리가 정해진다. 그래서 같은 방식으로 프레임마다
     * 다시 겨눈다 — 위쪽 줄들이 측정될 때마다 목표가 움직이므로.
     */
    if (!stickToBottom.current) {
      const anchor = useStore.getState().scrollAnchor[sessionId]
      if (!anchor) return
      let frames = 0
      let prev = -1
      stillLanding.current = true
      setSettling(true)
      const seek = () => {
        const el = scrollRef.current
        if (!el) return
        const index = chatRef.current.findIndex((c) => c.seq === anchor.seq)
        // 그 줄이 사라졌다면(기록을 다시 불러왔다든지) 되돌릴 자리가 없다 —
        // 억지로 비슷한 데 떨어뜨리느니 지금 보이는 것을 그대로 둔다
        if (index < 0) {
          stillLanding.current = false
          setSettling(false)
          return
        }
        const m = virtRef.current.measurementsCache[index]
        if (m) {
          const target = m.start + anchor.offset
          el.scrollTop = target
          lastTop.current = el.scrollTop
          // 목표가 멈췄다 = 위쪽 줄들이 다 재어졌다. 더 기다릴 이유가 없다
          if (Math.abs(target - prev) <= 1) setSettling(false)
          prev = target
        }
        if (++frames < LANDING_FRAMES) landing.current = requestAnimationFrame(seek)
        else {
          stillLanding.current = false
          setSettling(false)
        }
      }
      landing.current = requestAnimationFrame(seek)
      return
    }

    let frames = 0
    let mine = -1
    stillLanding.current = true
    setSettling(true)
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
        setSettling(false)
        return
      }
      el.scrollTop = el.scrollHeight
      mine = el.scrollTop
      lastTop.current = mine
      // 바닥에 닿았으면 이미 제자리다 — 루프는 계속 붙잡고 있되 화면은 지금 보여준다
      if (isAtBottom(el)) setSettling(false)
      if (++frames < LANDING_FRAMES) landing.current = requestAnimationFrame(step)
      else {
        stillLanding.current = false
        setSettling(false)
      }
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
  // 시켜서 들어온 지시도 "지금 하는 일"이므로 고정하되, 출처를 앞에 붙여 사람 말로 위장하지 않게 한다 (FR-11)
  // 이미지만 보낸 말은 text가 비어 있다 — 배너에는 첨부 이름이 그 말을 대신한다
  const pinnedText =
    pinned?.kind === 'user' ? pinned.text || (pinned.attachments?.map((a) => a.name).join(', ') ?? '') : null
  const stickyText =
    pinned?.kind === 'user' && pinnedText
      ? pinned.from
        ? `${pinned.from.name} ⤷ ${pinnedText}`
        : pinnedText
      : null

  // 접힘이 기본 — 다른 턴으로 넘어가면 펼침 상태를 끌고 가지 않는다
  const [stickyOpen, setStickyOpen] = useState(false)
  useEffect(() => setStickyOpen(false), [stickyIndex])

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
    // bottomPad: 카드가 자라면(첨부·여러 줄) 여백도 자란다 — 바닥에 붙어 있었으면 따라간다
  }, [totalSize, pending, working, bottomPad, scrollRef])

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      /* 사람이 대화에 손을 대면 '바닥으로 자리 잡기'는 거기서 끝난다 (#31) */
      onWheel={endLanding}
      onPointerDown={endLanding}
      onKeyDown={endLanding}
      /* min-h-0: overflow-y-auto가 걸려 있어도 줄어들지 못하면 스스로 늘어난다 */
      /*
       * invisible(= visibility:hidden)은 자리를 잡는 동안만이다 (#61 위 주석).
       * 재는 일은 계속되어야 하므로 레이아웃은 남기고 그림만 감춘다.
       */
      className={`min-h-0 flex-1 overflow-y-auto px-4 pt-4 text-[13px] leading-relaxed ${
        bottomPeek ? 'pb-14' : 'pb-4'
      } ${settling ? 'invisible' : ''}`}
      /* 카드가 앉을 빈 자리. 상태가 아니라 크기를 따르므로 전환도 애니메이션도 없다 */
      style={bottomPad === undefined ? undefined : { paddingBottom: `${bottomPad}px` }}
      data-testid="chat-stream"
      data-settling={settling || undefined}
    >
      {/*
        지금 보고 있는 턴이 어느 질문에 대한 답인지 — 긴 응답을 읽는 동안
        위로 되돌아가 확인하지 않아도 되게 한 줄로 남긴다.
      */}
      {stickyText !== null && (
        /*
          `top-0`이 아니라 음수 offset이다.
          이 스크롤 칸은 `py-4`를 두르고 있고, sticky는 **자기 컨테이닝 블록(부모의
          content box) 밖으로 못 나간다** — 그래서 `top-0`은 천장이 아니라 패딩 아래
          16px에 붙었다 (실측: gap 16px). 음수 offset이 그 16px을 되돌려 진짜 천장에
          닿게 한다. 패딩 자체는 남겨둔다: 맨 위로 올렸을 때 대화가 숨 쉴 자리다.

          16이 아니라 **10**인 이유: 6px 일부러 떨어뜨린다. 천장에 딱 붙이는 시도를
          두 번 했다 — 1px 겹침, 3px 겹침 + 불투명화. 트렁크 WebKit 실측으로는 틈 0
          이었는데 실제 WKWebView(구형 시스템 엔진)에서는 끝내 실금이 남았다
          (도그푸딩 세 번 지적 후 결론: 엔진의 합성 반올림은 우리가 못 이긴다).
          붙일 수 없다면 **일부러 떨어뜨린다** — 6px 간격은 실금(±1px)을 오차가 아니라
          디자인 안에 삼키고, 배너는 매달린 띠가 아니라 떠 있는 카드가 된다
          (그래서 아래 버튼은 말풍선과 같은 네 모서리 둥글림과 온전한 테두리를 입는다).
        */
        <div className="sticky -top-[10px] z-10 -mx-4 mb-1 flex justify-end px-4" data-testid="sticky-user">
          {/*
            말풍선과 **같은 옷, 같은 자리, 같은 폭**을 갖는다. 이 줄은 위로 사라진
            사용자 메시지의 연장이라, 하나라도 다르면 다른 종류의 것으로 읽힌다.

            폭을 전체로 두었을 때가 그랬다: 오른쪽에 붙은 75% 말풍선이 갑자기 좌우
            끝까지 뻗은 띠가 되니, 내 말이 아니라 **머리말 아래 떠 있는 도구 띠**로
            보였다 (도그푸딩: "위에 딱 안 붙었다"). 실측으로는 이미 붙어 있었다 —
            스크롤 칸 천장과의 간격 0px, 확대 0.9·1.0·1.1·1.15·1.2 전부 0px.
            떨어져 보이게 한 것은 위치가 아니라 모양이었다. 그래서 말풍선과 똑같이
            오른쪽 정렬에 `max-w-[75%]`로 두고, 폭은 글자 길이를 따라간다(w-fit).

            천장에서 6px 떠 있는 **카드**라서 말풍선과 같은 네 모서리 둥글림과 온전한
            테두리를 입는다 (붙이기를 접은 경위는 위 -top 주석에). 나타날 때 몇 px
            아래에서 올라와 멎는다(cc-hang) — 그 움직임이 "여기 떠 있다"를 말한다.
            (반투명+블러였던 시절이 있다 — "덮었다"를 보이려는 것이었는데, 비치는
            대화가 계속 "헤더와의 틈"으로 읽혀서 접었다.)

            누르면 펼쳐진다 — 한 줄로 부족한 질문을 위로 되돌아가지 않고 다시 읽는 용도.
            아주 긴 질문이 화면을 다 덮지 않게 높이만 자르고 안에서 스크롤한다.
          */}
          <div className="cc-hang relative w-fit max-w-[75%]">
            {/*
              **불투명이다** (도그푸딩 세 번째 지적 끝의 결론). 반투명+블러는 "가린 게
              아니라 덮었다"를 말하려는 것이었는데, 실측으로 기하학적 틈이 0인데도
              (헤더바닥=스크롤천장, WebKit 실측) 뒤로 비치는 대화가 계속 "헤더와의 틈"
              으로 읽혔다 — WKWebView는 스크롤 칸 안 sticky의 backdrop-filter가
              불안정해서 비침이 블러 없이 그대로 보이기도 한다. 말하려던 뉘앙스보다
              세 번 반복된 오독이 크다. 색은 graphite/55가 void 위에서 만들던 합성색을
              panel 토큰으로 대신한다 — 보이는 밝기는 그대로다.
            */}
            <button
              type="button"
              onClick={() => setStickyOpen((v) => !v)}
              aria-expanded={stickyOpen}
              className="w-full cursor-pointer truncate rounded-lg rounded-br-sm border border-slate/40 bg-graphite px-3 py-2 text-left text-[13px] text-chalk shadow-[0_8px_24px_-8px_rgb(0_0_0/0.8)]"
            >
              {stickyText}
            </button>
            {/*
              펼침은 flow가 아니라 **덮개**다. 배너가 흐름에서 키를 키우면 아래 가상
              스크롤의 좌표가 통째로 밀린다 — 접힌 한 줄이 자리를 지키고, 전문은 그
              위에 겹쳐서 보여준다. 아주 긴 질문은 높이를 자르고 안에서 스크롤한다.
            */}
            {stickyOpen && (
              <button
                type="button"
                onClick={() => setStickyOpen(false)}
                data-testid="sticky-user-expanded"
                /*
                  접힌 띠와 같은 모양이되 **여기는 덜 투명하다.** 접힌 줄의 투명함은
                  "가린 게 아니라 덮었다"를 보이려는 것이고, 펼친 이유는 읽으려는 것이다 —
                  긴 질문 위로 대화가 비치면 그 목적이 곧바로 깨진다.
                */
                className="absolute inset-x-0 top-0 z-10 max-h-60 cursor-pointer overflow-y-auto whitespace-pre-wrap break-words rounded-lg rounded-br-sm border border-slate/40 bg-graphite px-3 py-2 text-left text-[13px] text-chalk shadow-[0_8px_24px_-8px_rgb(0_0_0/0.8)]"
              >
                {stickyText}
              </button>
            )}
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
            /*
              배너가 흐름에 자리를 차지하며 리스트를 제 높이만큼 밀어내므로, "완전히
              지나갔다"고 판정된 원본이 배너 밑으로 되밀려 내려와 같은 말이 두 번
              보인다. 배너가 그 메시지를 대신 말하는 동안 원본은 숨긴다 — visibility라
              자리와 크기는 그대로여서 가상 스크롤의 측정은 흔들리지 않는다.
            */
            className={`absolute left-0 top-0 w-full min-w-0 ${
              chat[v.index]?.kind === 'user' ? 'pb-4 pt-6' : 'pb-3'
            } ${v.index === stickyIndex && stickyText !== null ? 'invisible' : ''}`}
            style={{ transform: `translateY(${v.start}px)` }}
          >
            <ChatRow item={chat[v.index]!} projectRoot={projectRoot} />
          </div>
        ))}
      </div>

      {pending && (
        <ApprovalCard sessionId={sessionId} requestId={pending.requestId} detail={pending.detail} />
      )}

      {/* 선택지는 여러 장이 겹칠 수 있다 — 하나만 그리면 나머지는 답할 길이 없다 */}
      {questions.map((q) => (
        <QuestionCard
          key={q.requestId}
          sessionId={sessionId}
          requestId={q.requestId}
          questions={q.questions}
        />
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
  // 생각의 양 (#58) — claude는 thinking 본문이 암호화라 이 추정치가 보여줄 수 있는 전부다
  const thinkingTokens = useStore((s) => s.sessions[sessionId]?.thinkingTokens ?? null)
  // 계획 스냅샷 (#58, codex) — activity와 같은 수명이라 여기(working 동안만 사는 줄)가 제자리다
  const plan = useStore((s) => s.sessions[sessionId]?.plan ?? null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // No instant means we genuinely do not know when this turn began — say nothing rather
  // than start a fresh count, which is the mistake this whole row is here to stop making
  const seconds = startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))

  return (
    <div className="py-2" data-testid="activity-row">
      {/*
        계획 체크리스트 (#58, codex turn/plan/updated). 진행 표시라 여기(working 동안만
        보이는 자리)에 산다 — 턴이 끝나면 activity와 함께 사라진다. 상태는 색이 아니라
        글리프로 가른다 (팔레트 규칙: 모양으로 구분한다).
      */}
      {plan && plan.length > 0 && (
        <ul className="mb-1.5 flex flex-col gap-0.5" data-testid="activity-plan">
          {plan.map((step, i) => (
            <li
              key={i}
              className={`flex items-baseline gap-1.5 text-[11px] ${step.status === 'inProgress' ? 'text-chalk' : 'text-slate'}`}
              data-testid={`plan-step-${i}`}
              data-status={step.status}
            >
              <span className="readout shrink-0" aria-hidden>
                {step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '▸' : '○'}
              </span>
              <span className={step.status === 'completed' ? 'line-through opacity-60' : undefined}>
                {step.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <span className="size-1.5 animate-pulse rounded-full bg-chalk" aria-hidden />
        {/*
        같은 '대기'가 아니다. 압축은 실측 39초까지 걸렸는데 문구가 같으면
        기다리는 사람은 멈춘 건지 오래 걸리는 건지 판단할 근거가 없다.
      */}
        <span className="text-[12px] text-ash" data-testid="activity-label">
          {activity === 'compacting'
            ? 'Compacting context'
            : activity === 'reviewing'
              ? 'Reviewing changes'
              : thinkingTokens
                ? `Thinking · ~${thinkingTokens >= 1000 ? `${(thinkingTokens / 1000).toFixed(1)}k` : thinkingTokens} tokens`
                : 'Waiting for response'}
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

    /*
     * 불러오기 한 번 = fire 한 번 (재진입 방지는 지역에서). loadOlder 자체도
     * loading/more를 지키므로 여분의 호출은 조용히 눕는다.
     */
    let firing = false
    const fire = () => {
      if (firing || loading) return
      firing = true
      const before = scroller.scrollHeight
      void loadOlder(sessionId).then(() => {
        // 늘어난 만큼 내려서 읽던 자리를 지킨다
        requestAnimationFrame(() => {
          const grew = scroller.scrollHeight - before
          if (grew > 0) scroller.scrollTop += grew
          firing = false
        })
      })
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) fire()
      },
      // 꼭대기에 닿기 조금 전에 미리 채운다 — 멈칫하는 순간이 안 보이게
      { root: scroller, rootMargin: '200px 0px 0px 0px' },
    )
    io.observe(el)
    /*
     * IO에만 걸지 않는다 (도그푸딩 2026-09-04: 실물 WKWebView에서 위 스크롤이
     * 옛 대화를 안 실었다 — Chromium 재현은 전부 통과). 관찰자가 안 깨어나는
     * 환경이 있어도 스크롤 위치는 거짓말하지 않는다 — 같은 fire라 이중 발화는 없다.
     */
    const onScroll = () => {
      if (scroller.scrollTop < 300) fire()
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      io.disconnect()
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [sessionId, more, loading, loadOlder, scrollRef])

  if (!more) return null
  /*
   * 클릭으로도 불러온다 (도그푸딩 2026-09-04: 메아·리소스 업로드에서 위 스크롤로
   * 옛 대화가 안 실렸다 — Chromium/목 재현은 전부 통과라 WKWebView의 IO/스크롤
   * 앵커링 차이가 유력하다). 관찰자가 어떤 이유로든 안 깨어나도 사람 손이 남고,
   * 실패하면 loadOlder의 토스트가 이유를 말한다 — 조용한 벽이 최악이다.
   */
  return (
    <div ref={ref} className="flex justify-center py-2" data-testid="load-older">
      <button
        type="button"
        onClick={() => void loadOlder(sessionId)}
        disabled={loading}
        className="readout rounded border border-edge px-2 py-0.5 text-[10px] text-slate transition-colors hover:border-graphite hover:text-chalk disabled:opacity-60"
      >
        {loading ? 'Loading earlier messages…' : 'Load earlier messages'}
      </button>
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

/**
 * 말풍선 한 줄.
 *
 * **memo인 이유는 스트리밍이다.** 답변이 흐르는 동안 델타 하나가 바꾸는 것은 마지막
 * 한 줄뿐인데(store의 message_delta는 나머지 항목의 정체성을 그대로 둔다), memo가
 * 없으면 조각 하나마다 화면에 보이는 말풍선이 **전부** 다시 그려졌다 — 긴 답변이
 * 화면을 채운 상태에서 그건 마크다운 재파싱 여러 번이다 (실측: 2.7 렌더/글자).
 * Markdown 자체는 이미 memo지만, 그 위의 껍데기가 매번 새로 도는 것은 못 막는다.
 */
const ChatRow = memo(function ChatRow({ item, projectRoot }: { item: ChatItem; projectRoot: string | null }) {
  if (item.kind === 'user') {
    return (
      <div className="flex flex-col items-end gap-0.5" data-testid="msg-user">
        {/*
          시켜서 들어온 말 (FR-11). 사람 말과 같은 자리(오른쪽)에 두되 — 세션 입장에선
          똑같이 "받은 지시"다 — 출처 이름을 위에 달고 테두리를 점선으로 바꾼다.
          색은 쓰지 않는다(팔레트 규칙): 구분은 밝기가 아니라 모양이 말하게 한다.
        */}
        {item.from && (
          <div className="text-[11px] text-ash" data-testid="msg-user-from">
            {item.from.name} ⤷
          </div>
        )}
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
        {/*
          첨부는 본문 위에 실물로 선다 — 이미지는 썸네일(누르면 확대), 파일은 이름 칩.
          예전엔 text에 "📎 이름"을 섞어 그렸는데, 그건 그림이 아니라 목록이었고
          보낸 원문과 그린 텍스트가 달라지는 부작용(#75)까지 낳았다.
        */}
        {item.attachments && item.attachments.length > 0 && (
          <div className="flex max-w-[75%] flex-wrap justify-end gap-1.5">
            {item.attachments.map((a, i) => (
              <UserAttachment key={`${a.path}-${i}`} att={a} />
            ))}
          </div>
        )}
        {/* 이미지만 보낸 말이면 빈 말풍선을 세우지 않는다 */}
        {(item.text || !item.attachments?.length) && (
          <div
            className={`max-w-[75%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm border bg-graphite px-3 py-2 text-chalk ${
              item.from ? 'border-dashed border-ash/50' : 'border-slate/40'
            }`}
          >
            {item.text}
          </div>
        )}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <div className="min-w-0" data-testid="msg-assistant">
        <Markdown text={item.text} projectRoot={projectRoot} />
      </div>
    )
  }
  if (item.kind === 'reasoning') {
    /*
     * 추론 요약 (#58). 본문이 아니라 본문에 이르는 길이므로 ash로 한 단계 가라앉힌다 —
     * 밝기가 곧 중요도라는 잉크 규칙 그대로. codex 요약은 **굵은 제목** 마크다운으로
     * 오므로 Markdown으로 그리되 바탕색 없이 조용히 둔다.
     */
    return (
      <div className="min-w-0 text-[13px] text-ash [&_strong]:text-ash" data-testid="msg-reasoning">
        <Markdown text={item.text} projectRoot={projectRoot} />
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
  if (item.kind === 'image') {
    /*
     * 에이전트가 내놓은 이미지 (#40). 표시 전용이라 저장되지 않는다 — 재시작하면
     * 터미널 스크롤백처럼 사라진다. data가 없으면 조용한 공백 대신 이유를 말한다
     * (실패는 보이게 — 앱 규칙).
     */
    if (!item.data) {
      return (
        <div
          className="rounded-lg border border-edge bg-panel px-3 py-2 text-[12px] text-slate"
          data-testid="msg-image-missing"
        >
          이미지를 표시하지 못했습니다{item.note ? ` — ${item.note}` : ''}
          {item.path && <span className="readout mt-1 block truncate text-[11px]">{item.path}</span>}
        </div>
      )
    }
    return <ImageMessage mime={item.mime} data={item.data} path={item.path} />
  }
  // 오케스트레이터의 프로젝트 제안 (#63) — 도구 카드가 아니라 사이드바를 가리키는 한 줄
  if (/propose_project$/.test(item.tool)) return <ProjectProposalRow item={item} />
  // 매니저의 워크트리 제안 (#69) — 같은 원칙: 가리키고, 값(브랜치 이름)은 창에 미리 채워진다
  if (/propose_worktree_session$/.test(item.tool)) return <WorktreeProposalRow item={item} />
  return <ToolCard item={item} />
})

/**
 * 대화 속 이미지 (#40 → #62 확대).
 *
 * 본문에서는 max-h-80으로 잘려 있어 스크린샷의 글자가 안 읽힌다 — 누르면 모달로
 * 크게 본다. Modal 컴포넌트를 그대로 쓰는 이유: 포털이라 그리드 칸의 overflow에
 * 갇히지 않고(#62에서 지적한 함정), esc·바깥 클릭 닫기를 다시 만들지 않는다.
 */
function ImageMessage({ mime, data, path }: { mime?: string; data: string; path?: string }) {
  return (
    <div className="min-w-0" data-testid="msg-image">
      <ZoomableImage
        src={`data:${mime};base64,${data}`}
        alt={path ?? 'agent image'}
        /* 세로로 화면을 다 덮지 않게 자른다 — 원본 비율은 유지 */
        thumbClassName="max-h-80 max-w-full rounded-lg border border-edge"
      />
    </div>
  )
}

/** 썸네일 + 확대 한 쌍 — 에이전트 이미지(#40)와 사용자 첨부가 같은 확대를 쓴다 */
function ZoomableImage({
  src,
  alt,
  thumbClassName,
  onError,
}: {
  src: string
  alt: string
  thumbClassName: string
  onError?: () => void
}) {
  const [zoom, setZoom] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setZoom(true)} title={alt} className="block cursor-zoom-in">
        <img src={src} alt={alt} className={thumbClassName} onError={onError} />
      </button>
      {zoom && (
        <Modal onClose={() => setZoom(false)} testId="image-lightbox">
          {/* vh/vw는 zoom을 모른다 — 다른 모달들과 같은 보정 (index.css --text-zoom) */}
          <img
            src={src}
            alt={alt}
            className="max-h-[calc(90vh/var(--text-zoom))] max-w-[calc(92vw/var(--text-zoom))] rounded-lg border border-edge"
          />
        </Modal>
      )}
    </>
  )
}

/**
 * 사용자가 실어 보낸 첨부 하나.
 *
 * 이미지면 실물 썸네일로 서고, 파일이거나 바이트가 없으면(재시작 후 500MB 상한 정리,
 * 깨진 데이터) 입력창의 칩과 같은 문법(IMG/DOC + 이름)으로 눕는다 — 무엇을 보냈는지는
 * 바이트가 사라져도 남아야 한다.
 */
function UserAttachment({ att }: { att: ChatAttachment }) {
  const [broken, setBroken] = useState(false)
  if (att.kind !== 'image' || !att.data || broken) {
    return (
      <span
        className="flex items-center gap-1.5 rounded border border-edge bg-panel px-2 py-1 text-[11px] text-ash"
        data-testid="msg-user-attachment"
        title={att.name}
      >
        <span className="readout text-[9px] text-slate">{att.kind === 'image' ? 'IMG' : 'DOC'}</span>
        <span className="max-w-40 truncate">{att.name}</span>
      </span>
    )
  }
  return (
    <span data-testid="msg-user-attachment">
      <ZoomableImage
        src={`data:${att.mime};base64,${att.data}`}
        alt={att.name}
        /* 말풍선 옆에 서는 것이라 에이전트 이미지보다 낮게 잡는다 */
        thumbClassName="max-h-48 max-w-full rounded-lg border border-slate/40"
        onError={() => setBroken(true)}
      />
    </span>
  )
}

/**
 * 프로젝트 제안 (#63) — **버튼이 아니라 손가락이다.**
 *
 * 처음엔 여기에 폴더 피커 버튼을 달았다. 도그푸딩에서 그게 틀렸음이 드러났다:
 * 사이드바의 Add project와 똑같은 일을 하는 문이 둘이 되고, 처음 보는 사람은
 * "프로젝트는 오케스트레이터에게 시키는 것"으로 배운다 — 정확히 반대여야 한다.
 * 폴더를 고르는 방법은 앱에 하나뿐이라는 규칙(사이드바 Add project)도 그 순간 깨진다.
 *
 * 그래서 이 줄은 아무것도 하지 않는다. 대신 **사이드바의 그 버튼에 불이 켜진다**
 * (store의 addProjectHint). 오케스트레이터가 하는 일은 문을 대신 여는 것이 아니라
 * 문이 어디 있는지 알려주는 것이고, 한 번 배운 자리는 다음부터 혼자 찾아간다.
 */
function ProjectProposalRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  // 어댑터가 이유를 제목에 실어 보낸다 (normalize의 propose_project 특례) —
  // 이유가 없으면 도구 이름이 그대로 오므로 그때는 기본 문장을 쓴다
  const reason = item.title && !/propose_project$/.test(item.title) ? item.title : null
  return (
    <p className="flex items-baseline gap-2 text-[12px] text-ash" data-testid="project-proposal">
      {/* 왼쪽 아래를 가리킨다 — 불이 켜진 버튼이 실제로 있는 방향이다 */}
      <span className="shrink-0 text-slate" aria-hidden>
        ↙
      </span>
      <span>
        <span className="text-chalk">Add project</span> at the bottom of the sidebar
        {reason ? ` — ${reason}` : ''}
      </span>
    </p>
  )
}

/**
 * 워크트리 제안 (#69) — propose_project와 같은 원칙(문은 하나, 여기는 손가락)에
 * 값이 하나 실린다: 브랜치 이름. 사이드바의 + 버튼이 밝아지고, 그 문을 열면
 * 워크트리가 켜지고 이름이 채워진 창이 뜬다. 만드는 것은 끝까지 사람이다.
 */
function WorktreeProposalRow({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const branch = item.title && !/propose_worktree_session$/.test(item.title) ? item.title : null
  return (
    <p className="flex items-baseline gap-2 text-[12px] text-ash" data-testid="worktree-proposal">
      <span className="shrink-0 text-slate" aria-hidden>
        ↖
      </span>
      <span>
        {branch ? (
          <>
            Branch <span className="font-mono text-chalk">{branch}</span> proposed
          </>
        ) : (
          'A worktree session was proposed'
        )}
        {' — the '}
        <span className="text-chalk">+</span>
        {' button on this project opens the prefilled dialog'}
      </span>
    </p>
  )
}

/** 접었을 때 맛보기로 보여줄 줄 수 — 무슨 명령이 뭘 뱉었는지 알아볼 만큼만 */
const PREVIEW_LINES = 3

/**
 * 맛보기의 **높이 상한** (사용자 지적 2026-09-12).
 *
 * PREVIEW_LINES는 `\n`으로 센 줄이다. 그런데 한 줄이 한 줄로 보이리라는 보장이 없다:
 * 리소스 업로드 응답처럼 개행 없는 JSON 한 덩어리가 오면 논리적으로는 1줄이라 맛보기
 * 자르기가 아무것도 안 자르고, 화면에서는 수십 줄로 접혀 카드가 대화를 통째로 덮는다.
 * "접혀 있는데 다 보인다"는 말이 이 뜻이었다.
 *
 * 그래서 상한을 하나 더 둔다 — **보이는 줄**로 센 높이. `lh`는 그 요소의 line-height
 * 한 줄이므로 3lh는 글자 크기나 leading을 바꿔도 늘 정확히 세 줄이다(px로 적으면
 * leading-relaxed × 11px = 17.875px 같은 값을 손으로 반올림하게 되고, 그 반올림이
 * 네 번째 줄의 머리를 한 픽셀 보여준다).
 */
const PREVIEW_CLAMP = 'max-h-[3lh] overflow-hidden'

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
  /*
   * 높이 상한에 **걸렸는지**는 세어서 알 수 없다 — 접히는 자리는 칸 너비가 정한다.
   * 재서 안다. 이게 없으면 개행 없는 한 덩어리(hidden === 0)가 소리 없이 잘린다:
   * 펼칠 것이 있다는 말을 아무도 안 하는 상태가 제일 나쁘다.
   */
  const outRef = useRef<HTMLPreElement>(null)
  const [clamped, setClamped] = useState(false)
  useLayoutEffect(() => {
    const el = outRef.current
    if (!el || open) {
      setClamped(false)
      return
    }
    const measure = () => setClamped(el.scrollHeight - el.clientHeight > 1)
    measure()
    // 칸 너비가 바뀌면 접히는 줄 수도 바뀐다 (그리드에서 칸은 늘 움직인다)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, item.result])
  /*
   * 실행 중 출력의 꼬리 (#58, codex outputDelta). result가 오기 전까지만 —
   * 맛보기와 달리 **끝쪽**을 보여준다: 돌아가는 명령에서 궁금한 건 처음이 아니라 지금이다.
   * (조각의 합은 전체가 아니다 — 실측에서 첫 조각이 빠졌다. 전체는 result가 가져온다.)
   */
  const liveTail =
    item.result === undefined && item.live
      ? item.live.replace(/\s+$/, '').split('\n').slice(-PREVIEW_LINES)
      : []

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

      {liveTail.length > 0 && (
        <div className="border-t border-edge px-2.5 py-1.5">
          <pre
            className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-slate ${PREVIEW_CLAMP}`}
            data-testid="tool-card-live"
          >
            {liveTail.join('\n')}
          </pre>
        </div>
      )}

      {lines.length > 0 && (
        <div className="border-t border-edge px-2.5 py-1.5">
          <pre
            ref={outRef}
            className={`whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ash ${
              open ? '' : PREVIEW_CLAMP
            }`}
            data-testid="tool-card-output"
          >
            {open ? lines.join('\n') : lines.slice(0, PREVIEW_LINES).join('\n')}
          </pre>
          {!open && (hidden > 0 || clamped) && (
            <button
              className="readout mt-1 text-[10px] text-slate transition-colors hover:text-chalk"
              onClick={() => setOpen(true)}
              data-testid="tool-card-more"
            >
              {/* 줄 수를 셀 수 있을 때만 센다 — 개행 없는 덩어리는 "몇 줄"이 거짓말이다 */}
              {hidden > 0 ? `${hidden} more lines` : 'Show all'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
