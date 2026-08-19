import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProjectInfo, SessionState, ToolName } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { NewSessionDialog } from '../project/NewSessionDialog.jsx'
import { AddProjectDialog } from '../project/AddProjectDialog.jsx'
import { useIsProjectSelected, useSelectedSessionId, useSessionsOf } from '../../store/selectors.js'
import { Tooltip, stateLabel } from '../../components/primitives.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { CloseIcon, PencilIcon, PlusIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { Modal } from '../../components/Modal.jsx'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from '../../store/store.js'
import { PROJECT_MIME, SESSION_MIME, dropsBefore, moveTo } from './reorder.js'

/**
 * 끌어서 순서 바꾸기.
 *
 * 끌고 있는 것의 **종류를 MIME으로 밝힌다.** 그래야 세션을 프로젝트 자리에
 * 떨어뜨렸을 때 아무 일도 안 일어난다 — 종류를 안 보면 엉뚱한 목록이 재배열된다.
 *
 * 놓일 자리는 선으로 보여준다. 선이 없으면 손을 떼기 전까지 어디로 갈지 알 수 없고,
 * 그러면 놓아 보고 되돌리는 일이 반복된다.
 */
function useDropLine(mime: string, onDrop: (draggedId: string, before: boolean) => void) {
  const [edge, setEdge] = useState<'top' | 'bottom' | null>(null)

  return {
    edge,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(mime)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const r = e.currentTarget.getBoundingClientRect()
        setEdge(dropsBefore(r, e.clientY) ? 'top' : 'bottom')
      },
      onDragLeave: () => setEdge(null),
      onDrop: (e: React.DragEvent) => {
        const id = e.dataTransfer.getData(mime)
        setEdge(null)
        if (!id) return
        e.preventDefault()
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        onDrop(id, dropsBefore(r, e.clientY))
      },
    },
  }
}

/**
 * 세션 한 줄. 끌 수 있고, 다른 줄을 받을 수 있다.
 *
 * 줄마다 놓기 상태를 따로 들고 있어야 **그 줄에만** 선이 그려진다 —
 * 하나로 묶어 두면 어느 줄 위인지 매번 다시 계산해야 한다.
 */
function SessionRow({
  id,
  onReorder,
  draggable,
  children,
}: {
  id: string
  onReorder: (draggedId: string, before: boolean) => void
  /**
   * 이름을 고치는 동안은 끌 수 없다. draggable인 조상 안의 input은 브라우저가
   * 글자 선택 대신 **끌기**로 해석해서, 고치려고 문지르면 줄이 통째로 딸려온다.
   */
  draggable: boolean
  children: ReactNode
}) {
  const drop = useDropLine(SESSION_MIME, onReorder)
  return (
    <li
      className={`group/row relative ${dropLine(drop.edge)}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_MIME, id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      {...drop.handlers}
    >
      {children}
    </li>
  )
}

/**
 * 놓일 자리 표시 — 얇은 선 하나면 충분하다.
 *
 * **테두리로 그리면 안 된다.** border는 요소의 크기를 1px 늘려서, 표시가 줄을 옮길
 * 때마다 목록 전체가 그만큼 밀린다 — 끌고 다니면 딸깍딸깍 튀는 그 느낌이다
 * (도그푸딩 지적). 게다가 손이 노리는 지점이 계속 움직이니 놓기도 어려워진다.
 *
 * inset 그림자는 **박스 크기를 건드리지 않는다.** 같은 선을 그리면서 레이아웃은
 * 가만히 있다. 새 DOM도 필요 없다.
 */
function dropLine(edge: 'top' | 'bottom' | null): string {
  if (!edge) return ''
  return edge === 'top'
    ? 'shadow-[inset_0_2px_0_0_var(--color-ash)]'
    : 'shadow-[inset_0_-2px_0_0_var(--color-ash)]'
}

/** 관찰 레인 — 밀도 높게, 공간은 조금만 (docs/architecture.md 설계 원칙 1) */
export function Sidebar() {
  const projectIds = useStore((s) => Object.keys(s.projects).join(','))
  const ids = projectIds ? projectIds.split(',') : []
  const width = useStore((s) => s.sidebarWidth)
  const setSidebarWidth = useStore((s) => s.setSidebarWidth)
  const [addOpen, setAddOpen] = useState(false)

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-y-auto border-r border-edge bg-pit"
      style={{ width }}
      data-testid="sidebar"
    >
      <ResizeHandle
        side="right"
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        onResize={setSidebarWidth}
        onReset={() => setSidebarWidth(SIDEBAR_DEFAULT)}
        testId="sidebar-resize"
      />
      <OrchestratorButton />
      <GridButton />
      {ids.length === 0 ? (
        <p className="px-4 py-6 text-xs leading-relaxed text-slate">
          No projects yet.
          <br />
          Start with <span className="text-ash">Add project</span> below.
        </p>
      ) : (
        ids.map((id) => <ProjectBlock key={id} projectId={id} />)
      )}
      {/*
        **누르는 곳과 나타나는 곳이 같아야 한다** (이슈 #4).
        예전엔 상단 바 오른쪽 끝에 있었다 — 화면 반대편을 눌러 놓고, 결과는
        왼쪽 사이드바에서 찾아야 했다. 새 프로젝트는 목록 **끝**에 붙으므로
        버튼도 목록 끝에 둔다: 누른 자리 바로 아래에 결과가 자란다.

        오케스트레이터·그리드처럼 밝히지 않는다. 저 둘은 자주 오가는 문이고
        이건 가끔 한 번 하는 일이라, 목록을 읽는 동안은 물러나 있어야 한다.
      */}
      <div className="px-2 py-2">
        <button
          className="flex w-full items-center gap-2 rounded-lg border border-edge px-2.5 py-1.5 text-left text-[12px] text-slate transition-colors hover:border-graphite hover:text-chalk"
          onClick={() => setAddOpen(true)}
          data-testid="add-project"
          title="Register a directory for agents to run in"
        >
          <PlusIcon size={13} />
          <span className="truncate">Add project</span>
        </button>
      </div>
      {addOpen && <AddProjectDialog onClose={() => setAddOpen(false)} />}
    </aside>
  )
}

/**
 * 오케스트레이터로 가는 문 — **말로 관제**.
 *
 * 그리드 바로 위에 둔다. 둘은 같은 것을 보는 두 방식이라 나란히 서야 한다:
 *   오케스트레이터  한 창에서 말로 시킨다
 *   그리드    여러 창을 눈으로 본다
 *
 * 프로젝트 밑이 아니다. 이 세션은 프로젝트에 속하지 않는다 —
 * 여러 프로젝트를 가로지르는 것이 존재 이유이기 때문이다.
 *
 * **아직 실험 중이라고 버튼에 적는다** (이슈 #1). 생김새가 그리드와 똑같아서
 * 사람이 그 차이를 모른 채 눌렀다. 표식을 오케스트레이터 화면 **안**에 두면
 * 이미 누른 뒤라 늦는다 — 막으려는 피해가 "모른 채 누르는 것"이기 때문이다.
 *
 * 팔레트 규칙(styles/index.css)을 그대로 따른다: **긴급도는 밝기로, 종류는 형태로.**
 *   - 글자는 slate(배경 정보 자리)다. 밝히면 그리드 버튼보다 급해 보이는 거짓말이 된다 —
 *     '실험 중'은 급한 것이 아니라 **알고 눌러야 하는 것**이다.
 *   - 테두리는 점선이다. 밝기를 한 방울도 쓰지 않고 "아직 굳지 않았다"를 말한다.
 *     글자만으로는 사이드바를 좁혔을 때 잘려 사라지지만, 형태는 남는다.
 */
function OrchestratorButton() {
  const view = useStore((s) => s.view)
  const open = useStore((s) => s.openOrchestrator)
  const active = view === 'orchestrator'

  return (
    <div className="px-2 pt-2">
      <button
        className={`flex w-full items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-left text-[12px] transition-colors ${
          active
            ? 'border-slate/50 bg-graphite text-chalk'
            : 'border-edge bg-panel text-ash hover:border-graphite hover:text-chalk'
        }`}
        // 그리드와 같은 규칙: 토글이 아니라 선택이다. 나가려면 다른 것을 고른다
        onClick={() => void open()}
        aria-pressed={active}
        data-testid="orchestrator-button"
        title="Experimental — one conversation that can direct your sessions. Expect rough edges."
      >
        <OrchestratorIcon />
        <span className="truncate font-medium tracking-tight">Orchestrator</span>
        <span className="shrink-0 text-[10px] text-slate" data-testid="orchestrator-experimental">
          Experimental
        </span>
      </button>
    </div>
  )
}

/** 갈래길 — 하나가 여럿으로 갈라지는 모양 */
function OrchestratorIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <circle cx="3" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="13" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.8 8h2.4M7.2 8c2 0 2.2-4.5 4.3-4.5M7.2 8h4.3M7.2 8c2 0 2.2 4.5 4.3 4.5"
        stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 그리드로 가는 문.
 *
 * **프로젝트와 다르게 생겨야 한다.** 목록의 다른 줄과 같은 모양이면 "프로젝트 하나"로
 * 읽히는데, 이건 프로젝트가 아니라 **보는 방식**이다. 둥근 박스로 감싸 목록에서
 * 떼어 놓는다 — 같은 종류가 아니라는 걸 글자보다 모양이 먼저 말한다.
 *
 * 세션을 여기 떨어뜨리면 그리드로 들어가면서 그 세션이 올라간다. 화면을 먼저
 * 열고 다시 끌어야 한다면 두 번 일하는 셈이라, 끌어온 김에 한 번에 처리한다.
 */
function GridButton() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const panels = useStore((s) => s.gridPanels)
  const setGridPanels = useStore((s) => s.setGridPanels)
  const [over, setOver] = useState(false)
  const active = view === 'grid'

  return (
    <div className="px-2 pb-1 pt-1.5">
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
          active
            ? 'border-slate/50 bg-graphite text-chalk'
            : 'border-edge bg-panel text-ash hover:border-graphite hover:text-chalk'
        } ${over ? 'shadow-[inset_0_0_0_2px_var(--color-ash)]' : ''}`}
        /*
          토글이 아니라 **선택**이다.
          껐다 켜는 스위치로 두면 "이전 화면 위에 잠깐 덮은 것"처럼 읽힌다 —
          실제로 그렇게 오해를 샀다. 사이드바의 다른 줄들과 같은 규칙으로 둔다:
          누르면 이것을 보고, 나가려면 다른 것을 고른다.
        */
        onClick={() => setView('grid')}
        aria-pressed={active}
        data-testid="grid-button"
        title="See sessions side by side"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(SESSION_MIME)) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(SESSION_MIME)
          setOver(false)
          if (!id) return
          e.preventDefault()
          if (!panels.includes(id)) void setGridPanels([...panels, id])
          setView('grid')
        }}
      >
        <GridIcon />
        <span className="truncate font-medium tracking-tight">Grid</span>
        {panels.length > 0 && <span className="readout ml-auto text-[10px] text-slate">{panels.length}</span>}
      </button>
    </div>
  )
}

/** 나뉜 화면 — 그리드가 하는 일을 그대로 그린 기호 */
function GridIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function ProjectBlock({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId])
  const focusedSessionId = useSelectedSessionId()
  const focusSession = useStore((s) => s.focusSession)
  const sessions = useSessionsOf(projectId)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  /** 지금 이름을 고치는 중인 세션. 한 번에 하나만 — 두 줄이 동시에 입력창이면 어느 쪽이 활성인지 모른다 */
  const [renaming, setRenaming] = useState<string | null>(null)
  const renameSession = useStore((s) => s.rename)
  const deleteSession = useStore((s) => s.deleteSession)
  const focusProject = useStore((s) => s.focusProject)
  const reorderProjects = useStore((s) => s.reorderProjects)
  const reorderSessions = useStore((s) => s.reorderSessions)
  const selected = useIsProjectSelected(projectId)

  /*
   * 훅은 **이른 return보다 먼저** 부른다. project가 없는 렌더가 한 번이라도 끼면
   * 훅 순서가 달라져 React가 던진다 — 프로젝트를 지우는 순간에 터지는 종류다.
   */
  const drop = useDropLine(PROJECT_MIME, (draggedId, before) => {
    const ids = Object.keys(useStore.getState().projects)
    void reorderProjects(moveTo(ids, draggedId, projectId, before))
  })

  if (!project) return null

  return (
    <section
      className={`border-b border-edge/70 py-2.5 ${dropLine(drop.edge)}`}
      data-testid={`project-${project.name}`}
      {...drop.handlers}
    >
      {/* 이름 줄을 잡아서 옮긴다 — 섹션 전체를 draggable로 두면 세션 끌기와 겹친다 */}
      <header
        className="group flex items-baseline gap-2 px-3"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PROJECT_MIME, projectId)
          e.dataTransfer.effectAllowed = 'move'
        }}
      >
        {/*
          프로젝트 이름을 누르면 깃·파일·터미널을 볼 수 있다 (세션을 고르지 않아도).
          브랜치·변경 수·동시 세션 같은 배경 정보는 **이름 아래에 줄을 만들지 않는다** —
          프로젝트가 여럿이면 그 줄들이 쌓여 정작 봐야 할 세션 목록을 밀어낸다.
          대신 물어볼 때(호버·포커스) 툴팁으로 답한다.
        */}
        <Tooltip content={<ProjectDetail project={project} sessionCount={sessions.length} />} testId={`project-tip-${project.name}`}>
          <button
            className={`truncate text-left text-[13px] font-medium tracking-tight transition-colors ${
              selected ? 'text-chalk underline decoration-graphite underline-offset-4' : 'text-chalk hover:text-beacon'
            }`}
            onClick={() => focusProject(projectId)}
            data-testid={`project-header-${project.name}`}
          >
            {project.name}
          </button>
        </Tooltip>

        {/*
          자리를 새로 차지하지 않는 표식만 이름 줄에 남긴다.
          특히 동시 세션은 데이터 유실 위험을 알리는 신호라, 툴팁 뒤로 완전히
          숨기면 "막지 말고 보이게 하라"를 어기게 된다 (FR-2).
        */}
        <ProjectMarks project={project} sessionCount={sessions.length} />
        {/*
          **항상 보인다.** 예전엔 호버해야 나타났는데, 새 세션은 이 앱에서 가장 자주 하는 일이라
          "있는 줄도 몰랐다"가 나오면 안 된다 (도그푸딩에서 지적됨).
          크기를 키우는 것만으로는 안 된다 — 안 보이는 것은 아무리 커도 안 보인다.
          평소엔 slate로 눌러 두고 호버에서 밝아지게 해서, 세션 목록을 읽는 데는 방해하지 않는다.
        */}
        <span className="-my-1 ml-auto shrink-0">
          <IconButton
            label={`New session in ${project.name}`}
            onClick={() => setNewSessionOpen(true)}
            testId={`new-session-${project.name}`}
            align="right"
          >
            <PlusIcon size={15} />
          </IconButton>
        </span>
      </header>

      <ul className="mt-1.5">
        {sessions.map((s) => {
          const unread = s.lastSeq > s.lastReadSeq
          const focused = focusedSessionId === s.id
          return (
            <SessionRow
              key={s.id}
              id={s.id}
              draggable={renaming !== s.id}
              onReorder={(draggedId, before) =>
                void reorderSessions(projectId, moveTo(sessions.map((x) => x.id), draggedId, s.id, before))
              }
            >
              {renaming === s.id ? (
                <SessionNameInput
                  id={s.id}
                  initial={s.name}
                  onDone={(name) => {
                    setRenaming(null)
                    // 같은 이름이면 왕복할 이유가 없다 (실패 토스트가 뜰 이유도 없다)
                    if (name && name !== s.name) void renameSession(s.id, name)
                  }}
                />
              ) : (
                <>
                  <button
                    onClick={() => focusSession(s.id)}
                    /*
                      이름을 두 번 누르면 그 자리에서 고친다 — 파일 탐색기·탭 이름의 관행이라
                      버튼을 못 찾은 사람도 손이 먼저 안다. 연필 버튼은 그 관행을 모르는
                      사람을 위한 두 번째 입구다: 어느 한쪽만 두면 절반은 이름을 못 고친다.
                    */
                    onDoubleClick={() => setRenaming(s.id)}
                    data-testid={`session-row-${s.id}`}
                    /*
                      오른쪽 여백은 호버에 나타나는 버튼 **두 개**를 비켜야 한다.
                      pr-8은 삭제 하나만 있던 시절의 값이라, 연필이 늘면서 긴 이름이
                      버튼 밑으로 들어간다 — 가려진 글자는 잘린 글자보다 나쁘다.
                    */
                    className={`flex w-full items-center gap-2 border-l-2 py-1.5 pl-2.5 pr-14 text-left text-[13px] transition-colors ${
                      focused
                        ? 'border-l-ash bg-graphite/40 text-chalk'
                        : 'border-l-transparent text-ash hover:bg-graphite/20 hover:text-chalk'
                    }`}
                  >
                    {/*
                      표식 하나가 두 가지를 말한다: 글자는 도구, 테두리는 상태.
                      점을 따로 두면 표식 바로 옆에서 둘이 겹쳐 읽혀 오히려 둘 다 흐려진다.
                    */}
                    <ToolMark tool={s.tool} state={s.state} />
                    <span className={`truncate ${unread && !focused ? 'text-chalk' : ''}`}>{s.name}</span>
                    {unread && (
                      <span
                        className="ml-auto size-1 shrink-0 rounded-full bg-ash"
                        data-testid={`unread-${s.id}`}
                        title="Unread"
                      />
                    )}
                  </button>
                  {/*
                    이름 고치기와 삭제만 둔다.

                    '치우기'를 따로 두려 했지만, 삭제해도 도구(클로드·코덱스)에는 대화가
                    그대로 남아 '+ → 이전 대화'로 되찾을 수 있다. 그러면 둘의 실질 차이가
                    거의 없어서 버튼만 늘고 무엇이 다른지 설명하기 어려워진다.
                    대신 **무엇이 지워지고 무엇이 남는지**를 확인 창에서 분명히 말한다.
                  */}
                  {/*
                    오른쪽 여백은 프로젝트 헤더의 px-3과 같아야 한다 — 둘은 사이드바에서
                    같은 세로줄에 서는 버튼이라, 4px과 12px로 달라 두면 눈에 바로 걸린다
                    (도그푸딩 지적). 한쪽만 고치면 다시 어긋나므로 값을 맞춰 둔다.
                  */}
                  <span className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
                    {/*
                      이름 고치기는 삭제 **왼쪽**에 둔다. 되돌릴 수 없는 일(삭제)이 바깥쪽
                      끝에 서야, 손이 목록 밖에서 들어올 때 그것부터 지나치지 않는다.
                    */}
                    <IconButton
                      label="Rename (auto-naming stops)"
                      testId={`rename-session-${s.id}`}
                      align="right"
                      onClick={() => setRenaming(s.id)}
                    >
                      <PencilIcon size={13} />
                    </IconButton>
                    {/*
                      삭제는 호버에서만 나타난다 — 되돌릴 수 없는 일을 목록에 늘어놓으면
                      누르려던 것 옆에서 잘못 눌린다. 대신 나타났을 때는 확실히 잡히도록 키웠다.
                    */}
                    <IconButton
                      label="Delete permanently (history goes too)"
                      testId={`delete-session-${s.id}`}
                      align="right"
                      onClick={() => setConfirming(s.id)}
                    >
                      <CloseIcon size={13} />
                    </IconButton>
                  </span>
                </>
              )}
            </SessionRow>
          )
        })}
      </ul>

      {newSessionOpen && <NewSessionDialog projectId={projectId} onClose={() => setNewSessionOpen(false)} />}

      {confirming && (
        <ConfirmDelete
          sessionId={confirming}
          name={sessions.find((s) => s.id === confirming)?.name ?? 'Session'}
          // 프로젝트 기본값이 아니라 이 세션의 도구다 — 어디에 기록이 남는지 알려주는 문장이라 틀리면 안 된다
          tool={sessions.find((s) => s.id === confirming)?.tool ?? project.defaultTool}
          onCancel={() => setConfirming(null)}
          onConfirm={(deleteWorktree) => {
            void deleteSession(confirming, deleteWorktree)
            setConfirming(null)
          }}
        />
      )}
    </section>
  )
}

/**
 * 세션 이름을 그 자리에서 고친다 (이슈 #5).
 *
 * **모달을 띄우지 않는다.** 이름은 다른 이름들 사이에서 골라야 뜻이 생긴다 —
 * 화면을 덮으면 무엇과 헷갈렸는지 안 보이는 채로 이름을 짓게 된다.
 * 자동 이름이 첫 프롬프트를 잘라 쓰기 때문에 `This session is being continued…`가
 * 넷씩 나란히 서던 문제라, 고치는 동안 나머지 넷이 보여야 한다.
 *
 * 빈 이름은 **취소로 친다.** 지우고 나가는 실수로 이름 없는 줄을 만들면
 * 그 줄은 목록에서 아무것도 가리키지 못한다.
 */
function SessionNameInput({ id, initial, onDone }: { id: string; initial: string; onDone: (name: string) => void }) {
  const [text, setText] = useState(initial)
  /*
   * Enter로 확정하면 입력창이 사라지는데, 사라지는 순간 blur도 한 번 더 온다.
   * 막지 않으면 같은 이름으로 두 번 보낸다 — 한 번은 성공하고 한 번은 실패해서
   * 아무 이유 없는 오류 토스트가 뜬다.
   */
  const done = useRef(false)
  const finish = (name: string) => {
    if (done.current) return
    done.current = true
    onDone(name.trim())
  }

  return (
    <input
      autoFocus
      className="w-full border-l-2 border-l-ash bg-graphite/40 py-1.5 pl-2.5 pr-3 text-[13px] text-chalk outline-none"
      value={text}
      onChange={(e) => setText(e.target.value)}
      // 자동 이름은 통째로 갈아치우는 게 보통이라 전체를 잡아 둔다 (덧붙이려면 → 한 번)
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        // 전역 단축키(⌘K 등)가 타이핑을 가로채지 않게 여기서 멈춘다
        e.stopPropagation()
        if (e.key === 'Enter') finish(text)
        else if (e.key === 'Escape') finish(initial)
      }}
      // 다른 곳을 눌러 나가도 고친 값을 살린다 — 확정 버튼이 따로 없다
      onBlur={() => finish(text)}
      data-testid={`session-name-input-${id}`}
      spellCheck={false}
    />
  )
}

/**
 * 삭제 확인.
 *
 * **무엇이 지워지고 무엇이 남는지를 분명히 말한다.**
 * "되돌릴 수 없습니다"만 쓰면 사실과 다르다 — 도구(클로드·코덱스)에는 대화가
 * 그대로 남아서 '+ → 이전 대화'로 되찾을 수 있다. 실제보다 무섭게 말하면
 * 사람은 정리하지 못하고 목록만 쌓인다.
 */
function ConfirmDelete({
  sessionId,
  name,
  tool,
  onConfirm,
  onCancel,
}: {
  sessionId: string
  name: string
  tool: string
  onConfirm: (deleteWorktree: boolean) => void
  onCancel: () => void
}) {
  const platform = usePlatform()
  const toolLabel = tool === 'codex' ? 'Codex' : 'Claude Code'

  /*
   * 워크트리 세션인지, 거기 커밋 안 된 변경이 있는지 **모달을 여는 순간 묻는다.**
   * 세션 목록에는 경로만 있고 더러운지는 없다 — 그건 파일시스템을 봐야 아는 사실이다.
   */
  const [wt, setWt] = useState<{ path: string; branch: string; dirty: boolean; changedFiles: number } | null>(null)
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  useEffect(() => {
    let alive = true
    void platform.agents
      .worktreeStatus(sessionId)
      .then((r) => alive && setWt(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [platform, sessionId])
  return (
    <Modal onClose={onCancel} testId="confirm-delete">
      <div className="w-[380px] max-w-[90vw] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]">
        <p className="text-[13px] text-chalk">Delete this session?</p>
        <p className="mt-1.5 truncate text-[12px] text-ash">{name}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate">
          Chat history and attachments in Centralu will be gone.
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-ash" data-testid="delete-notice">
          The conversation stays in {toolLabel} — you can pull it back from <span className="text-chalk">+ → Past conversations</span>.
        </p>

        {/*
          워크트리는 **세션과 수명이 다르다.** 에이전트가 몇 시간 작업한 결과가 거기 있을 수 있어
          기본은 남기는 쪽이다. 지우려면 사람이 직접 켠다 — 그리고 무엇을 잃는지 먼저 읽는다.
        */}
        {wt && (
          <div className="mt-3 rounded border border-edge bg-panel p-2.5" data-testid="delete-worktree">
            <p className="text-[11px] text-ash">
              This session ran in a worktree — <span className="font-mono text-chalk">{wt.branch}</span>
            </p>
            {wt.dirty && (
              <p className="mt-1 text-[11px] text-chalk" data-testid="worktree-dirty">
                {wt.changedFiles} uncommitted {wt.changedFiles === 1 ? 'change' : 'changes'} would be lost.
              </p>
            )}
            <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-[11px] text-ash hover:text-chalk">
              <input
                type="checkbox"
                className="mt-0.5 accent-ash"
                checked={deleteWorktree}
                onChange={(e) => setDeleteWorktree(e.target.checked)}
                data-testid="delete-worktree-toggle"
              />
              <span>
                Delete the worktree too
                <span className="mt-0.5 block text-[10px] break-all text-slate">{wt.path}</span>
              </span>
            </label>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk hover:border-graphite"
            onClick={() => onConfirm(deleteWorktree)}
            data-testid="confirm-delete-yes"
          >
            Delete
          </button>
        </div>
      </div>
    </Modal>
  )
}

/** 이름 줄에 얹는 표식 — 세로 공간을 새로 쓰지 않는다 */
function ProjectMarks({
  project,
  sessionCount,
}: {
  project: ProjectInfo
  sessionCount: number
}) {
  const changed = project.git?.changedFiles ?? 0
  const risky = sessionCount > 1
  const denied = project.git?.denied === true

  return (
    /*
      **이름 바로 옆에 붙인다.** ml-auto로 반대쪽 끝까지 밀어 놨더니, 이 숫자들이
      무엇에 대한 것인지 이름과 떨어져서 안 읽혔다 (도그푸딩: "이 숫자는 뭐야?").
      바로 옆에 있으면 "이 프로젝트의 변경 22개"로 한 덩어리로 읽힌다.

      설명은 **앱 툴팁**으로 준다. 브라우저 기본 title은 1~2초를 기다려야 뜨는데,
      "이게 뭐지?" 싶을 때 그만큼 멈춰 있어야 하면 그냥 안 물어보게 된다.
      숫자만 있고 단위가 없는 표식일수록 답이 빨라야 한다.
    */
    <span className="readout flex shrink-0 items-center gap-1.5 text-[10px] text-slate">
      {changed > 0 && (
        <Tooltip content={`${changed} uncommitted file${changed > 1 ? 's' : ''}`} testId={`mark-changed-tip-${project.name}`}>
          <span data-testid={`mark-changed-${project.name}`}>{changed}</span>
        </Tooltip>
      )}
      {/* 겹친 사각형 = 같은 폴더에서 여럿이 일하는 중 */}
      {risky && (
        <Tooltip
          content={`${sessionCount} sessions running in the same folder — they can overwrite each other's edits`}
          testId={`concurrent-tip-${project.name}`}
        >
          <span className="text-ash" data-testid={`concurrent-${project.name}`}>
            ⧉{sessionCount}
          </span>
        </Tooltip>
      )}
      {denied && (
        <Tooltip content="Folder access permission required" testId={`git-denied-tip-${project.name}`}>
          <span className="text-ash" data-testid={`git-denied-${project.name}`}>
            !
          </span>
        </Tooltip>
      )}
    </span>
  )
}

/** 툴팁 내용 — 평소엔 자리를 안 주지만 물어보면 전부 답한다 */
function ProjectDetail({ project, sessionCount }: { project: ProjectInfo; sessionCount: number }) {
  return (
    <span className="block" data-testid={`project-detail-${project.name}`}>
      <span className="readout block truncate text-slate">{project.path}</span>
      <span className="mt-1 block">
        {project.git?.denied ? (
          // '저장소 아님'으로 표시하면 사용자가 엉뚱한 결론을 낸다 — 할 일은 권한 부여다
          <span className="text-chalk" data-testid="git-denied">
            Folder access permission required — System Settings → Privacy & Security → Files and Folders
          </span>
        ) : project.git ? (
          <>
            <span className="text-chalk">{project.git.branch}</span>
            {project.git.changedFiles > 0 && <span> · {project.git.changedFiles} changed</span>}
          </>
        ) : (
          <span>not a git repo</span>
        )}
      </span>
      {sessionCount > 1 && (
        <span className="mt-1 block text-chalk" data-testid="concurrent-detail">
          {sessionCount} concurrent sessions — editing the same files can lose changes
        </span>
      )}
    </span>
  )
}

/**
 * 어느 도구의 세션인가.
 *
 * **공식 로고를 쓰지 않는다.** 두 회사의 마크는 상표이고 각자 브랜드 가이드라인이 있다 —
 * 로고 파일을 앱에 넣어 배포하면 그 규칙에 걸릴 수 있다. 우리 글리프면 그 문제 자체가 없고,
 * 무채색·형태로 구분하는 이 앱의 규칙과도 맞는다.
 *
 * 이게 없으면 제목이 비슷한 두 세션을 구분할 방법이 없다 (도그푸딩에서 실제로 착각했다).
 */
/**
 * 세션 표식 — 도구와 상태를 한 자리에서.
 *
 * **공식 로고를 쓰지 않는다.** 두 회사의 마크는 상표이고 각자 브랜드 가이드라인이 있다 —
 * 로고 파일을 앱에 넣어 배포하면 그 규칙에 걸릴 수 있다. 우리 글리프면 그 문제 자체가 없고,
 * 무채색·형태로 구분하는 이 앱의 규칙과도 맞는다.
 *
 * 테두리가 상태다. 밝을수록 급하다 — 이 앱 전체를 관통하는 규칙 그대로다.
 * '작업 중'만 회전한다: 멈춘 것과 도는 것은 정지 화면에서도 구분되므로,
 * "일하는 중인가 멈춘 건가"라는 질문에 움직임만큼 확실히 답하는 게 없다.
 *
 * 멈춘 상태(한도·오류)는 글자를 흐리게 해서 활성 상태와 구분한다.
 * 여섯 상태를 테두리 밝기만으로 다 가르기는 어려워서, 이름은 툴팁에 그대로 싣는다.
 */
const RING: Record<SessionState, string> = {
  working: '', // cc-orbit가 배경을 맡는다
  waiting_approval: 'var(--color-beacon)',
  error: 'var(--color-beacon)',
  waiting_input: 'var(--color-ash)',
  limited: 'var(--color-slate)',
  idle: 'transparent',
}

function ToolMark({ tool, state }: { tool: ToolName; state: SessionState }) {
  const toolName = tool === 'codex' ? 'Codex' : 'Claude Code'
  const label = `${toolName} · ${stateLabel(state)}`
  const stalled = state === 'limited' || state === 'error'

  return (
    <span
      className={`shrink-0 rounded-[5px] p-[1.5px] ${state === 'working' ? 'cc-orbit' : ''}`}
      style={state === 'working' ? undefined : { background: RING[state] }}
      title={label}
      aria-label={label}
      data-testid={`tool-mark-${tool}`}
      data-state={state}
    >
      <span
        /*
         * 밝은 칩에 어두운 글자 — 목록에서 한눈에 잡히되,
         * 순백(beacon)은 쓰지 않는다. 그건 "나를 기다리는 것"의 몫이라
         * 여기서 써버리면 진짜 신호가 묻힌다. 한 단계 낮은 chalk를 쓴다.
         * 글자는 터미널 폰트(모노) — 한 글자 기호는 폭이 고정돼야 줄이 흔들리지 않는다.
         */
        /*
          어두운 바탕에 밝은 글자다. 밝은 칩이었더니 회전하는 궤도가 그 밝기에 묻혀
          정작 '작업 중'이 안 보였다 — 표식이 상태를 겸하는데 상태가 안 보이면
          표식을 옮긴 의미가 없다.

          사이드바 배경(pit)과 칩 배경(void)은 두 단계 차이뿐이라 테두리 하나로는
          잘 안 떨어진다. 테두리를 더 밝게 올리는 대신 **키캡과 같은 손길**(cc-chip)을
          쓴다: 위쪽 1px 하이라이트와 아래쪽 그림자. 밝기를 더 쓰지 않고도 물체로
          떨어져 보이는데, 밝기는 이 앱에서 긴급도를 말하는 자원이라 장식에 쓰면
          그만큼 신호가 깎인다.
        */
        className={`readout cc-chip flex size-[14px] items-center justify-center rounded-[3.5px] border border-graphite bg-void text-[9px] font-semibold leading-none text-chalk ${
          stalled ? 'opacity-50' : ''
        }`}
      >
        {tool === 'codex' ? 'X' : 'C'}
      </span>
    </span>
  )
}
