import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { TOOL_META, type ProjectInfo, type SessionState, type ToolName } from '@cc/protocol'
import type { SessionSummary } from '@cc/core'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { NewSessionDialog } from '../project/NewSessionDialog.jsx'
import { WorktreeManagerDialog } from '../project/WorktreeManagerDialog.jsx'
import { DeleteProjectDialog } from '../project/DeleteProjectDialog.jsx'
import { useIsProjectSelected, useSelectedSessionId, useSessionsOf } from '../../store/selectors.js'
import { Tooltip, stateLabel } from '../../components/primitives.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { DotsIcon, PlusIcon } from '../../components/icons.jsx'
import { Modal } from '../../components/Modal.jsx'
import { useOrbitSync } from '../../components/orbit.js'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, useTextZoom } from '../../store/store.js'
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
  nested,
  children,
}: {
  id: string
  onReorder: (draggedId: string, before: boolean) => void
  /**
   * 이름을 고치는 동안은 끌 수 없다. draggable인 조상 안의 input은 브라우저가
   * 글자 선택 대신 **끌기**로 해석해서, 고치려고 문지르면 줄이 통째로 딸려온다.
   */
  draggable: boolean
  /**
   * 매니저 아래에 들여 그려지는 워크트리 세션인가 (#69).
   * 들여쓰기 + 세로 안내선 — 계급은 사이드바에만 산다 (그리드는 평평하다, 설계 결정).
   */
  nested?: boolean
  children: ReactNode
}) {
  const drop = useDropLine(SESSION_MIME, onReorder)
  return (
    <li
      data-nested={nested || undefined}
      className={`group/row relative ${nested ? 'ml-4 border-l border-edge/60' : ''} ${dropLine(drop.edge)}`}
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
  // 최소 폭은 실픽셀 고정 — 글자를 키워도 목록을 좁힐 수 있는 한계는 그대로다
  const zoom = useTextZoom()
  const platform = usePlatform()
  const addProject = useStore((s) => s.addProject)
  const setToast = useStore((s) => s.setToast)
  const [adding, setAdding] = useState(false)
  // 오케스트레이터가 이 버튼을 가리키는 중인가 (#63)
  const hint = useStore((s) => s.addProjectHint)

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col overflow-y-auto border-r border-edge bg-pit"
      style={{ width }}
      data-testid="sidebar"
    >
      <ResizeHandle
        side="right"
        min={SIDEBAR_MIN / zoom}
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
          /*
           * 오케스트레이터가 여기를 가리키면 불이 켜진다 (#63).
           *
           * 대화 안에 또 하나의 폴더 피커를 두는 대신 **이 버튼 하나를 밝힌다** —
           * 문은 앱에 하나여야 하고, 두 번째 문을 그리면 사람은 "프로젝트는
           * 오케스트레이터에게 시키는 것"으로 배운다. 유채색은 쓰지 않는다
           * (팔레트 규칙): 평소 물러나 있던 이 버튼이 chalk로 올라오는 것만으로
           * 화면에서 가장 밝은 것이 되고, 그게 곧 "여기"라는 뜻이다.
           */
          className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors disabled:opacity-40 ${
            hint
              ? 'breathe border-ash text-chalk'
              : 'border-edge text-slate hover:border-graphite hover:text-chalk'
          }`}
          /*
           * **폴더를 고르는 방법은 앱에 하나뿐이어야 한다.**
           *
           * 여기는 원래 절대 경로를 손으로 치는 창을 열었다 — 웹 개발 시절의 폴백이
           * Tauri로 넘어오며 그대로 남은 것이다. 첫 실행 화면은 진작 네이티브 피커를
           * 쓰고 있었으니, 같은 일을 두 방법으로 시키면서 **더 자주 쓰는 쪽에 더 나쁜
           * 방법**을 두고 있었다 (Finder 열고 경로 복사해서 돌아오기).
           * 창이 통째로 사라지고 버튼이 곧 피커가 된다.
           */
          onClick={async () => {
            setAdding(true)
            try {
              const picked = await platform.system.pickDirectory()
              if (picked) await addProject(picked)
            } catch (e) {
              setToast((e as Error).message)
            } finally {
              setAdding(false)
            }
          }}
          disabled={adding}
          data-testid="add-project"
          data-hint={hint || undefined}
          title="Register a directory for agents to run in"
        >
          <PlusIcon size={13} />
          <span className="truncate">Add project</span>
        </button>
      </div>
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
 * 글자는 slate(배경 정보 자리)다. 밝히면 그리드 버튼보다 급해 보이는 거짓말이 된다 —
 * '실험 중'은 급한 것이 아니라 **알고 눌러야 하는 것**이다.
 *
 * 테두리는 한때 점선이었다. 근거는 "사이드바를 좁히면 글자는 잘려 사라지고 형태만
 * 남는다"였는데, **재보니 사실이 아니었다.** 'Experimental' 배지는 `shrink-0`이라
 * 가장 좁은 폭(180px, 버튼 163px)에서도 63px 그대로 서 있고, 대신 잘리는 것은 이름
 * 쪽이다. 지키던 것이 없었으니 점선도 남을 이유가 없다.
 */
function OrchestratorButton() {
  const view = useStore((s) => s.view)
  const open = useStore((s) => s.openOrchestrator)
  const active = view === 'orchestrator'

  return (
    <div className="px-2 pt-2">
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
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

/**
 * 왕관 — 다른 세션을 부리는 자리의 표식 (사양서 FR-11의 원래 그림).
 * 갈래길 모양을 썼었는데, 오케스트레이터 배지(글자 'orch')와 서로 다르게
 * 생겨서 같은 역할이 두 얼굴을 가졌다 — 왕관 하나로 통일한다 (2026-08-26 사용자 결정).
 * 채색은 안 한다: 긴급함은 밝기의 몫이고, 이건 종류의 표식이다.
 */
function OrchestratorIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      {/* 그리드 아이콘처럼 뷰박스를 거의 채운다 — 같은 13px인데 도형이 절반만 쓰면 작아 보인다 */}
      <path
        d="M2.6 13.5 L1.8 4.6 L5.9 7.4 L8 2.6 L10.1 7.4 L14.2 4.6 L13.4 13.5 Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
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
 *
 * **The Experimental badge is gone** (2026-08-27, by the user's call). It went up when the
 * grid shipped looking finished while the spec still listed it under non-goals (issue #25) —
 * the mark existed to warn about the hour you might lose inside an unproven view. Weeks of
 * dogfooding later the grid is simply how sessions get watched side by side, and a warning
 * that no longer warns anyone is clutter on the one lane that is always on screen.
 * The orchestrator's badge stays — that surface still is what its mark says it is.
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
        title="See sessions side by side."
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

/**
 * 세션 목록을 트리 순서로 편다 (#69): 매니저 바로 아래에 그 워크트리 자식들.
 *
 * 계급은 사이드바에만 산다 — 그리드·인박스·팔레트는 평평한 목록 그대로다 (설계 결정:
 * "The hierarchy lives in the sidebar; the grid stays a flat set of panels").
 *
 * 부모가 이 목록에 없으면(아카이브됨 등) 자식은 최상위로 그린다 — 들여쓰기는 관계의
 * 표시일 뿐이라, 부모가 안 보이는데 들여 그리면 없는 것 아래 매달린 것처럼 보인다.
 */
function orderAsTree(
  sessions: SessionSummary[],
): { s: SessionSummary; nested: boolean; managerOfLive: number }[] {
  const here = new Set(sessions.map((x) => x.id))
  const kids = new Map<string, SessionSummary[]>()
  const roots: SessionSummary[] = []
  for (const s of sessions) {
    if (s.parentSessionId && here.has(s.parentSessionId)) {
      kids.set(s.parentSessionId, [...(kids.get(s.parentSessionId) ?? []), s])
    } else {
      roots.push(s)
    }
  }
  return roots.flatMap((root) => {
    const children = kids.get(root.id) ?? []
    return [
      { s: root, nested: false, managerOfLive: children.length },
      ...children.map((c) => ({ s: c, nested: true, managerOfLive: 0 })),
    ]
  })
}

function ProjectBlock({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId])
  const focusedSessionId = useSelectedSessionId()
  const focusSession = useStore((s) => s.focusSession)
  const sessions = useSessionsOf(projectId)
  // 창의 열림은 스토어가 든다 — 첫 실행 화면도 이 창을 열어야 하기 때문이다
  const newSessionOpen = useStore((s) => s.newSessionFor === projectId)
  const openNewSession = useStore((s) => s.openNewSession)
  const [confirming, setConfirming] = useState<string | null>(null)
  /** 인수인계 확인 창이 떠 있는 세션 (없으면 null) */
  const [handingOff, setHandingOff] = useState<string | null>(null)
  /** 열린 세션 메뉴 — 줄이 여럿이라 앵커는 ref가 아니라 누른 버튼 요소로 든다 */
  const [sessionMenu, setSessionMenu] = useState<{ id: string; el: HTMLElement } | null>(null)
  /** 지금 이름을 고치는 중인 세션. 한 번에 하나만 — 두 줄이 동시에 입력창이면 어느 쪽이 활성인지 모른다 */
  const [renaming, setRenaming] = useState<string | null>(null)
  const renameSession = useStore((s) => s.rename)
  const deleteSession = useStore((s) => s.deleteSession)
  const handoffSession = useStore((s) => s.handoffSession)
  const focusProject = useStore((s) => s.focusProject)
  const reorderProjects = useStore((s) => s.reorderProjects)
  const reorderSessions = useStore((s) => s.reorderSessions)
  const selected = useIsProjectSelected(projectId)
  // 매니저의 워크트리 제안이 이 프로젝트를 가리키는가 (#69) — + 버튼이 밝아진다
  const proposalHere = useStore((s) => s.worktreeProposals.some((p) => p.projectId === projectId))
  const [managerDialog, setManagerDialog] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  /** 메뉴가 매달릴 자리 — 누른 버튼이다 (사이드바 모서리가 아니라) */
  const menuAnchor = useRef<HTMLSpanElement>(null)
  const [deleting, setDeleting] = useState(false)

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
        <Tooltip
          content={<ProjectDetail project={project} sessionCount={sessions.length} />}
          testId={`project-tip-${project.name}`}
        >
          <button
            className={`truncate text-left text-[13px] font-medium tracking-tight transition-colors ${
              selected
                ? 'text-chalk underline decoration-graphite underline-offset-4'
                : 'text-chalk hover:text-beacon'
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
          이 줄의 모든 동작이 한 버튼 뒤에 있다 (도그푸딩 요청).

          예전에는 `+`(새 세션)가 **항상** 보였다. 그때의 이유는 "새 세션은 가장 자주 하는
          일이라 있는 줄도 몰랐다가 나오면 안 된다"였고, 그 이유는 여전히 옳다 — 다만 그
          사이 이 줄에 할 일이 셋이 됐다(새 세션·워크트리 매니저·프로젝트 삭제). 셋을 다
          아이콘으로 늘어놓으면 프로젝트 이름보다 버튼이 길어진다. 그래서 하나로 접고,
          대신 **평소에는 감춘다**: 접힌 버튼이 늘 떠 있으면 목록을 읽는 눈만 방해한다.

          감췄지만 잃지 않는다 — 키보드 포커스(focus-within)와 워크트리 제안(#69)은
          호버 없이도 버튼을 꺼낸다. 특히 제안: 숨은 버튼을 반짝이게 해봐야 아무도 못 본다.
        */}
        <span
          ref={menuAnchor}
          className={`-my-1 ml-auto shrink-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 ${
            menuOpen || proposalHere ? 'opacity-100' : 'opacity-0'
          } ${proposalHere ? 'breathe rounded text-chalk' : ''}`}
          data-testid={`project-actions-${project.name}`}
          data-worktree-proposal={proposalHere || undefined}
        >
          {/*
            IconButton이 아니라 맨 버튼이다 — 툴팁을 떼기 위해서 (도그푸딩 2026-09-02).
            누르면 이름 붙은 메뉴가 바로 그 자리에 뜨는 버튼이라, 호버 툴팁은 설명이
            아니라 열린 메뉴 옆에 겹쳐 남는 소음이었다. 스크린리더용 이름은 남긴다.
          */}
          <button
            type="button"
            aria-label={`Actions for ${project.name}`}
            onClick={() => setMenuOpen((v) => !v)}
            data-testid={`project-menu-${project.name}`}
            className="flex items-center justify-center rounded p-1 text-slate transition-colors hover:bg-graphite/60 hover:text-chalk"
          >
            <DotsIcon size={14} />
          </button>
        </span>
        {menuOpen && (
          <ProjectMenu
            project={project}
            anchorEl={menuAnchor.current}
            onClose={() => setMenuOpen(false)}
            onNewSession={() => openNewSession(projectId)}
            onStartManager={() => setManagerDialog(true)}
            onDelete={() => setDeleting(true)}
          />
        )}
      </header>

      <ul className="mt-1.5">
        {orderAsTree(sessions).map(({ s, nested, managerOfLive }) => {
          const unread = s.lastSeq > s.lastReadSeq
          const focused = focusedSessionId === s.id
          return (
            <SessionRow
              key={s.id}
              id={s.id}
              nested={nested}
              /*
               * 자식 줄은 끌 수 없다 — 자리가 곧 소속이다 (#69). 부모 아래 들여
               * 그려지는 줄을 손으로 옮기게 두면, 옮긴 자리가 소속처럼 읽히는데
               * 실제 소속(parentSessionId)은 그대로라 화면이 거짓말을 하게 된다.
               */
              draggable={renaming !== s.id && !nested}
              onReorder={(draggedId, before) =>
                void reorderSessions(
                  projectId,
                  moveTo(
                    sessions.map((x) => x.id),
                    draggedId,
                    s.id,
                    before,
                  ),
                )
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
                      안읽음(FR-16)은 이름 밝기가 말한다 (아래 truncate의 text-chalk).
                      화면에 없는 사실을 테스트가 볼 수 있게 속성으로도 남긴다 —
                      클래스 이름을 단언하면 색을 고칠 때마다 테스트가 깨진다.
                    */
                    data-unread={(unread && !focused) || undefined}
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
                    {/*
                      병합됨 (#69) — 이 브랜치의 작업이 줄기에 들어갔다. 이력이지 진행 중인
                      일이 아니라는 표시고, 이 상태의 자식은 매니저 삭제를 붙들지 않는다.
                      트리 정리는 사람이 삭제 대화에서 한다 (거긴 이미 무엇이 남는지 말한다).
                    */}
                    {s.merged && (
                      <span
                        className="shrink-0 rounded border border-edge px-1 text-[9px] leading-relaxed text-slate"
                        data-testid={`merged-badge-${s.id}`}
                        title="Branch merged into the trunk — safe to clean up from the delete dialog"
                      >
                        merged
                      </span>
                    )}
                    {/*
                      안읽음 점은 여기 있다가 **지워졌다** (도그푸딩 2026-09-02).

                      같은 사실을 이 줄에서 세 번째로 말하고 있었다: 도구 표식의 테두리가
                      상태를(턴이 끝나면 ash 링), 이름 밝기가 안읽음을(위의 text-chalk)
                      이미 말한다. 딴 데 있는 동안 턴이 끝나면 셋이 한꺼번에 켜지니
                      점은 정보를 더하지 않고 "저건 또 뭐지"라는 질문만 더했다 —
                      실제로 그 질문을 받았다. 판정(lastReadSeq·markRead)은 그대로다.
                    */}
                  </button>
                  {/*
                    아이콘 넷(연필·인수인계·워크트리·삭제) 대신 메뉴 하나 (도그푸딩 요청 —
                    프로젝트 줄과 같은 문법). 아이콘이 넷이 되자 이름 없는 그림 맞추기가
                    됐고, 그중 둘(인수인계·삭제)은 잘못 누르면 안 되는 것이었다.
                  */}
                  {/*
                    오른쪽 여백은 프로젝트 헤더의 px-3과 같아야 한다 — 둘은 사이드바에서
                    같은 세로줄에 서는 버튼이라, 4px과 12px로 달라 두면 눈에 바로 걸린다
                    (도그푸딩 지적). 한쪽만 고치면 다시 어긋나므로 값을 맞춰 둔다.
                  */}
                  <span
                    className={`absolute right-3 top-1/2 flex -translate-y-1/2 items-center transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 ${
                      sessionMenu?.id === s.id ? 'opacity-100' : 'opacity-0'
                    }`}
                    data-testid={`session-actions-${s.id}`}
                  >
                    {/* 프로젝트 ⋯와 같은 맨 버튼 — 이름 붙은 메뉴가 바로 뜨므로 툴팁은 소음이다 */}
                    <button
                      type="button"
                      aria-label={`Actions for ${s.name}`}
                      onClick={(e) => {
                        // updater 안에서 읽으면 늦다 — React가 핸들러를 끝내며 currentTarget을 비운다
                        const el = e.currentTarget
                        setSessionMenu((cur) => (cur?.id === s.id ? null : { id: s.id, el }))
                      }}
                      data-testid={`session-menu-${s.id}`}
                      className="flex items-center justify-center rounded p-1 text-slate transition-colors hover:bg-graphite/60 hover:text-chalk"
                    >
                      <DotsIcon size={14} />
                    </button>
                  </span>
                  {sessionMenu?.id === s.id && (
                    <SessionMenu
                      session={s}
                      managerOfLive={managerOfLive}
                      anchorEl={sessionMenu.el}
                      onClose={() => setSessionMenu(null)}
                      onRename={() => setRenaming(s.id)}
                      onNewWorktree={() => openNewSession(projectId, { worktree: true })}
                      onHandoff={() => setHandingOff(s.id)}
                      onDelete={() => setConfirming(s.id)}
                    />
                  )}
                </>
              )}
            </SessionRow>
          )
        })}
      </ul>

      {newSessionOpen && <NewSessionDialog projectId={projectId} onClose={() => openNewSession(null)} />}
      {managerDialog && (
        <WorktreeManagerDialog projectId={projectId} onClose={() => setManagerDialog(false)} />
      )}
      {deleting && <DeleteProjectDialog project={project} onClose={() => setDeleting(false)} />}

      {confirming && (
        <ConfirmDelete
          sessionId={confirming}
          name={sessions.find((s) => s.id === confirming)?.name ?? 'Session'}
          // 프로젝트 기본값이 아니라 이 세션의 도구다 — 어디에 기록이 남는지 알려주는 문장이라 틀리면 안 된다
          tool={sessions.find((s) => s.id === confirming)?.tool ?? project.defaultTool}
          onCancel={() => setConfirming(null)}
          onConfirm={(deleteWorktree, deleteExternal) => {
            void deleteSession(confirming, deleteWorktree, deleteExternal)
            setConfirming(null)
          }}
        />
      )}

      {handingOff && (
        <ConfirmHandoff
          name={sessions.find((s) => s.id === handingOff)?.name ?? 'Session'}
          tool={sessions.find((s) => s.id === handingOff)?.tool ?? project.defaultTool}
          onCancel={() => setHandingOff(null)}
          onConfirm={(tool, deleteOld) => {
            // 창은 닫고 진행은 세션 안에서 보인다 — 인수인계 요청과 글이 그대로 대화에 남는다
            void handoffSession(handingOff, { tool, deleteOld })
            setHandingOff(null)
          }}
        />
      )}
    </section>
  )
}

/**
 * 인수인계 확인 창 (도그푸딩 요청).
 *
 * 순서를 문장으로 다 말한다 — 이 버튼 하나가 "글 부탁 → 새 세션 → (기본값) 진짜 삭제"
 * 세 단계를 묶기 때문이다. 파괴가 끝에 있으므로 경고는 삭제 팔레트로 선다 (프로젝트
 * 삭제와 같은 문법). 이름 타이핑은 요구하지 않는다: 마지막 단계가 실패해도 세션 둘이
 * 남을 뿐 잃는 것이 없고, 성공했다면 잃는 것은 사람이 방금 읽고 승인한 그것뿐이다.
 *
 * 받는 에이전트를 고를 수 있다 (도그푸딩 요청) — 글은 그냥 텍스트라 도구를 가리지
 * 않는다. 기본은 지금 도구. 삭제도 체크박스다: 끄면 갈아타기가 아니라 분기가 된다.
 */
function ConfirmHandoff({
  name,
  tool,
  onConfirm,
  onCancel,
}: {
  name: string
  tool: ToolName
  onConfirm: (tool: ToolName, deleteOld: boolean) => void
  onCancel: () => void
}) {
  const [heirTool, setHeirTool] = useState<ToolName>(tool)
  const [deleteOld, setDeleteOld] = useState(true)
  const toolLabel = TOOL_META[tool].label
  return (
    <Modal onClose={onCancel} testId="confirm-handoff">
      <div className="w-[400px] max-w-[calc(90vw/var(--text-zoom))] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]">
        <p className="text-[13px] text-chalk">Hand off to a fresh session?</p>
        <p className="mt-1.5 truncate text-[12px] text-ash">{name}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-ash">
          This session writes a handoff note (you will see it in the conversation), then a fresh session
          starts from that note.
        </p>

        {/* 받는 에이전트 — 다른 도구를 고르면 모델·강도 같은 도구별 설정은 물려주지 않는다 */}
        <p className="mt-3 text-[10px] uppercase tracking-[0.12em] text-slate">Hand off to</p>
        <div className="mt-1 flex gap-1.5" role="radiogroup" aria-label="Hand off to">
          {(Object.keys(TOOL_META) as ToolName[]).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={heirTool === t}
              data-testid={`handoff-tool-${t}`}
              onClick={() => setHeirTool(t)}
              className={`rounded border px-2.5 py-1 text-[12px] transition-colors ${
                heirTool === t
                  ? 'border-ash bg-graphite text-chalk'
                  : 'border-edge bg-panel text-ash hover:border-graphite hover:text-chalk'
              }`}
            >
              {TOOL_META[t].label}
              {t === tool && <span className="ml-1 text-[10px] text-slate">(current)</span>}
            </button>
          ))}
        </div>

        {deleteOld ? (
          <p
            className="mt-3 rounded border border-del/40 bg-del-bg px-2.5 py-2 text-[11px] leading-relaxed text-chalk"
            data-testid="handoff-warning"
          >
            When the new session is ready,{' '}
            <span className="text-del">this session is deleted for real — including the {toolLabel} conversation
            file</span>. Only the note survives.
          </p>
        ) : (
          <p className="mt-3 text-[11px] leading-relaxed text-ash" data-testid="handoff-keep-note">
            This session stays — the new one starts from the note alongside it.
          </p>
        )}
        <label
          className={`mt-2 flex cursor-pointer items-start gap-2 text-[11px] ${
            deleteOld ? 'text-del' : 'text-ash hover:text-chalk'
          }`}
          data-testid="handoff-delete-toggle"
        >
          <input
            type="checkbox"
            className={`mt-0.5 ${deleteOld ? 'accent-del' : 'accent-ash'}`}
            checked={deleteOld}
            onChange={(e) => setDeleteOld(e.target.checked)}
          />
          <span>Delete this session after the handoff</span>
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={`rounded border px-3 py-1 text-[12px] transition-colors ${
              deleteOld
                ? 'border-del/40 bg-del-bg text-del hover:border-del/70'
                : 'border-edge bg-panel text-chalk hover:border-graphite'
            }`}
            onClick={() => onConfirm(heirTool, deleteOld)}
            data-testid="confirm-handoff-yes"
          >
            Hand off
          </button>
        </div>
      </div>
    </Modal>
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
function SessionNameInput({
  id,
  initial,
  onDone,
}: {
  id: string
  initial: string
  onDone: (name: string) => void
}) {
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
/**
 * 프로젝트 줄의 행동 메뉴.
 *
 * 아이콘 세 개 대신 목록 하나인 이유는 **이름이 필요해서**다. `+`는 새 세션이라고
 * 배울 수 있었지만, 가지 아이콘이 워크트리 매니저이고 휴지통이 프로젝트 삭제라는 건
 * 눌러 보기 전에는 모른다 — 그리고 그중 하나는 눌러 보면 안 되는 것이다.
 *
 * 삭제는 **맨 아래, 선 하나 아래**다. 위쪽 둘은 매일 하는 일이고 이건 한 번 하는 일이라,
 * 손이 기억으로 움직일 때 같은 무리에 있으면 안 된다.
 */
/**
 * 사이드바 줄 메뉴의 공통 껍데기 — 배치(줌 보정·뒤집기·가장자리)와 닫힘 규칙이 여기 산다.
 * 프로젝트 메뉴에서 뽑아냈다: 세션 줄도 같은 메뉴를 갖게 되면서, 이 계산을 두 번
 * 적으면 한쪽만 고치는 미래가 눈에 보였다 (줌 보정이 이미 한 번 그랬다).
 */
function RowMenu({
  anchorEl,
  testId,
  onClose,
  children,
}: {
  anchorEl: HTMLElement | null
  testId: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  /*
   * **누른 버튼 아래에 뜬다.**
   *
   * 예전에는 `absolute right-2 top-6`이었다. 이 줄에는 자기 positioned 조상이 없어서
   * 그 좌표는 사이드바 전체를 기준으로 풀렸고, 어느 프로젝트를 누르든 메뉴는 사이드바
   * 우상단 한 자리에 떴다 — 열 번째 프로젝트를 눌렀는데 답이 맨 위에서 나온다
   * (도그푸딩 지적). 메뉴는 **자기를 부른 것 옆에** 있어야 무엇에 대한 메뉴인지 읽힌다.
   *
   * `fixed`인 이유: 사이드바는 `overflow-y-auto`라, 흐름 안에 두면 목록 아래쪽 프로젝트의
   * 메뉴가 잘린다. 뷰포트 기준으로 띄우면 잘릴 상자가 없다.
   *
   * 아래에 자리가 없으면 위로 뒤집는다. 그래서 높이를 **먼저 재야** 하는데, 높이는
   * 그려 봐야 안다 — useLayoutEffect(그리기 전에 돈다)로 재고 자리를 정하므로,
   * 자리가 안 정해진 프레임은 화면에 나가지 않는다 (visibility로 가려 둔다).
   */
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current
      if (!anchorEl || !el) return
      /*
       * **전부 레이아웃 px로 환산해서 계산한다** — 확대(--text-zoom) 때문이다.
       *
       * getBoundingClientRect는 확대가 곱해진 화면 px를 주는데, 여기서 정한 top/right는
       * 확대된 루트 안의 길이라 그릴 때 확대가 **한 번 더** 곱해진다. 그대로 섞으면
       * 확대 1.1에서 메뉴가 버튼보다 24px 아래, 103px 왼쪽에 떴다 (1.25에선 54px/249px —
       * 실측. 도그푸딩 "메뉴 위치가 이상해"의 정체다). e2e가 확대 1.0에서만 재서 놓쳤다.
       *
       * 창 크기(innerWidth/Height)는 확대를 모르고, offsetHeight는 원래 레이아웃 px다 —
       * 화면 px(rect)와 창 px만 확대로 나눠서 한 좌표계로 모은다.
       */
      const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--text-zoom')) || 1
      const r = anchorEl.getBoundingClientRect()
      const h = el.offsetHeight
      const w = el.offsetWidth
      const winH = window.innerHeight / zoom
      const winW = window.innerWidth / zoom
      const GAP = 4 // 버튼과 메뉴 사이 — 붙여 놓으면 어디까지가 버튼인지 안 보인다
      const EDGE = 8 // 창 가장자리에 딱 붙지 않게
      const below = r.bottom / zoom + GAP
      setPos({
        top: below + h <= winH - EDGE ? below : Math.max(EDGE, r.top / zoom - GAP - h),
        /*
         * 오른쪽 끝을 버튼에 맞춘다 — 메뉴가 버튼에서 흘러나온 것처럼 읽힌다.
         * 단 왼쪽 가장자리도 지킨다 (도그푸딩: 사이드바가 좁으면 메뉴가 창 왼쪽 밖으로
         * 나가 안 보였다). right는 "창 오른쪽에서 얼마"라 값이 클수록 메뉴가 왼쪽으로
         * 가는데, 버튼이 창 왼쪽 가까이 서면 메뉴 폭만큼이 화면 밖이 된다 —
         * 메뉴의 왼쪽 끝이 EDGE 안쪽에 남도록 위에서 자른다.
         */
        right: Math.max(EDGE, Math.min(winW - r.right / zoom, winW - EDGE - w)),
      })
    }
    place()
    /*
     * 사이드바가 스크롤되면 버튼은 움직이는데 fixed 메뉴는 안 움직인다 — 다시 붙인다.
     * capture로 듣는 이유: 스크롤은 버블링하지 않아서 window의 일반 리스너로는
     * 사이드바 안쪽 스크롤이 안 잡힌다.
     */
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchorEl])
  /*
   * 바깥을 누르면 닫는다. 메뉴가 열린 채로 다른 프로젝트를 누르면 두 메뉴가 동시에
   * 떠 있는 것처럼 보이는데, 실제로는 각자 자기 상태를 들고 있어 아무도 안 닫힌다.
   */
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // capture: 아래에서 stopPropagation 하는 줄들이 있어도 닫힘은 반드시 온다
    window.addEventListener('mousedown', away, true)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('mousedown', away, true)
      window.removeEventListener('keydown', esc, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      data-testid={testId}
      className="fixed z-30 w-48 rounded border border-edge bg-panel py-1 shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
      style={{ top: pos?.top ?? 0, right: pos?.right ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>
  )
}

/** 메뉴 한 줄. 닫기는 onClick에 묶어서 받는다 — 여는 쪽이 onClose를 안다 */
function ActionRow({
  label,
  onClick,
  testId,
  danger,
}: {
  label: string
  onClick: () => void
  testId: string
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={onClick}
      className={`block w-full px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-graphite/25 ${
        danger ? 'text-ash hover:text-beacon' : 'text-ash hover:text-chalk'
      }`}
    >
      {label}
    </button>
  )
}

function ProjectMenu({
  project,
  anchorEl,
  onClose,
  onNewSession,
  onStartManager,
  onDelete,
}: {
  project: ProjectInfo
  anchorEl: HTMLElement | null
  onClose: () => void
  onNewSession: () => void
  onStartManager: () => void
  onDelete: () => void
}) {
  const pick = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return (
    <RowMenu anchorEl={anchorEl} testId={`project-menu-open-${project.name}`} onClose={onClose}>
      <ActionRow label="New session" onClick={pick(onNewSession)} testId={`new-session-${project.name}`} />
      {/*
        매니저 자리를 **먼저** 만드는 문 (#76). 저장소이면서 아직 자리가 없을 때만 나온다 —
        만들고 나면 그 자리는 세션 목록에 줄로 서 있으므로, 같은 일을 하는 문이 둘이 되지 않는다.
      */}
      {project.git?.isRepo && !project.worktreeManager && (
        <ActionRow
          label="Start worktree manager"
          onClick={pick(onStartManager)}
          testId={`start-worktree-manager-${project.name}`}
        />
      )}
      <div className="my-1 border-t border-edge" />
      <ActionRow
        label="Delete project…"
        onClick={pick(onDelete)}
        testId={`delete-project-${project.name}`}
        danger
      />
    </RowMenu>
  )
}

/**
 * 세션 줄의 행동 메뉴 (도그푸딩: 호버 아이콘이 넷까지 늘었다 — 연필·인수인계·워크트리·
 * 삭제. 프로젝트 줄이 아이콘 셋에서 메뉴로 간 것과 같은 이유다: **이름이 필요하다.**
 * 인수인계 화살표가 무엇인지는 눌러 보기 전에 모르고, 그중 둘은 눌러 보면 안 되는 것이다.)
 *
 * 삭제는 맨 아래 선 하나 아래 — 매일 하는 일과 한 번 하는 일을 같은 무리에 두지 않는다.
 */
function SessionMenu({
  session,
  managerOfLive,
  anchorEl,
  onClose,
  onRename,
  onNewWorktree,
  onHandoff,
  onDelete,
}: {
  session: SessionSummary
  managerOfLive: number
  anchorEl: HTMLElement | null
  onClose: () => void
  onRename: () => void
  onNewWorktree: () => void
  onHandoff: () => void
  onDelete: () => void
}) {
  const pick = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return (
    <RowMenu anchorEl={anchorEl} testId={`session-menu-open-${session.id}`} onClose={onClose}>
      <ActionRow label="Rename" onClick={pick(onRename)} testId={`rename-session-${session.id}`} />
      {/* 매니저 줄에만 — 이 세션 아래에 워크트리 세션을 하나 더 (#69) */}
      {managerOfLive > 0 && (
        <ActionRow
          label="New worktree session"
          onClick={pick(onNewWorktree)}
          testId={`new-worktree-session-${session.id}`}
        />
      )}
      {/* 워크트리 세션은 아직 못 한다 — 워크트리의 수명이 세션에 묶여 있다 */}
      {!session.worktree && (
        <ActionRow
          label="Hand off to a fresh session…"
          onClick={pick(onHandoff)}
          testId={`handoff-session-${session.id}`}
        />
      )}
      <div className="my-1 border-t border-edge" />
      <ActionRow
        label="Delete session…"
        onClick={pick(onDelete)}
        testId={`delete-session-${session.id}`}
        danger
      />
    </RowMenu>
  )
}

function ConfirmDelete({
  sessionId,
  name,
  tool,
  onConfirm,
  onCancel,
}: {
  sessionId: string
  name: string
  tool: ToolName
  onConfirm: (deleteWorktree: boolean, deleteExternal: boolean) => void
  onCancel: () => void
}) {
  const platform = usePlatform()
  const toolLabel = TOOL_META[tool].label
  /*
   * 도구 쪽 원본까지 지울지 (도그푸딩 "진짜로 삭제"). 기본은 남긴다 — 아래 안내문이
   * 약속하는 "되돌릴 길"이 그 파일이다. 켜면 안내문이 같은 자리에서 경고로 바뀐다
   * (프로젝트 삭제와 같은 문법: 두 문장을 같이 띄워 고르게 하지 않는다).
   */
  const [deleteExternal, setDeleteExternal] = useState(false)

  /*
   * 워크트리 세션인지, 거기 커밋 안 된 변경이 있는지 **모달을 여는 순간 묻는다.**
   * 세션 목록에는 경로만 있고 더러운지는 없다 — 그건 파일시스템을 봐야 아는 사실이다.
   */
  const [wt, setWt] = useState<{ path: string; branch: string; dirty: boolean; changedFiles: number } | null>(
    null,
  )
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
      <div className="w-[380px] max-w-[calc(90vw/var(--text-zoom))] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]">
        <p className="text-[13px] text-chalk">Delete this session?</p>
        <p className="mt-1.5 truncate text-[12px] text-ash">{name}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate">
          Chat history and attachments in Centralu will be gone.
        </p>
        {deleteExternal ? (
          <p
            className="mt-1 rounded border border-del/40 bg-del-bg px-2 py-1.5 text-[11px] leading-relaxed text-chalk"
            data-testid="delete-external-warning"
          >
            <span className="text-del">The conversation file in {toolLabel} is deleted too</span> — there will
            be nothing left to pull back.
          </p>
        ) : (
          <p className="mt-1 text-[11px] leading-relaxed text-ash" data-testid="delete-notice">
            The conversation stays in {toolLabel} — you can pull it back from{' '}
            <span className="text-chalk">+ → Past conversations</span>.
          </p>
        )}
        <label
          className={`mt-2 flex cursor-pointer items-start gap-2 text-[11px] ${
            deleteExternal ? 'text-del' : 'text-ash hover:text-chalk'
          }`}
          data-testid="delete-external-toggle"
        >
          <input
            type="checkbox"
            className={`mt-0.5 ${deleteExternal ? 'accent-del' : 'accent-ash'}`}
            checked={deleteExternal}
            onChange={(e) => setDeleteExternal(e.target.checked)}
          />
          <span>Delete the {toolLabel} conversation file too</span>
        </label>

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
            onClick={() => onConfirm(deleteWorktree, deleteExternal)}
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
function ProjectMarks({ project, sessionCount }: { project: ProjectInfo; sessionCount: number }) {
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
        <Tooltip
          content={`${changed} uncommitted file${changed > 1 ? 's' : ''}`}
          testId={`mark-changed-tip-${project.name}`}
        >
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
  const label = `${TOOL_META[tool].label} · ${stateLabel(state)}`
  const stalled = state === 'limited' || state === 'error'
  // 그리드 칸 테두리와 **같은 각도**로 돈다 (components/orbit.ts)
  useOrbitSync(state === 'working')

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
        {TOOL_META[tool].mark}
      </span>
    </span>
  )
}
