import { useState, type ReactNode } from 'react'
import type { ProjectInfo, SessionState, ToolName } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { NewSessionDialog } from '../project/NewSessionDialog.jsx'
import { useSessionsOf } from '../../store/selectors.js'
import { Tooltip, stateLabel } from '../../components/primitives.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
import { CloseIcon, PlusIcon } from '../../components/icons.jsx'
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
  children,
}: {
  id: string
  onReorder: (draggedId: string, before: boolean) => void
  children: ReactNode
}) {
  const drop = useDropLine(SESSION_MIME, onReorder)
  return (
    <li
      className={`group/row relative ${dropLine(drop.edge)}`}
      draggable
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
      <ControlCenterButton />
      {ids.length === 0 ? (
        <p className="px-4 py-6 text-xs leading-relaxed text-slate">
          No projects yet.
          <br />
          Start with <span className="text-ash">Add project</span> above.
        </p>
      ) : (
        ids.map((id) => <ProjectBlock key={id} projectId={id} />)
      )}
    </aside>
  )
}

/**
 * 컨트롤 센터로 가는 문.
 *
 * **프로젝트와 다르게 생겨야 한다.** 목록의 다른 줄과 같은 모양이면 "프로젝트 하나"로
 * 읽히는데, 이건 프로젝트가 아니라 **보는 방식**이다. 둥근 박스로 감싸 목록에서
 * 떼어 놓는다 — 같은 종류가 아니라는 걸 글자보다 모양이 먼저 말한다.
 *
 * 세션을 여기 떨어뜨리면 컨트롤 센터로 들어가면서 그 세션이 올라간다. 화면을 먼저
 * 열고 다시 끌어야 한다면 두 번 일하는 셈이라, 끌어온 김에 한 번에 처리한다.
 */
function ControlCenterButton() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const panels = useStore((s) => s.gridPanels)
  const setGridPanels = useStore((s) => s.setGridPanels)
  const [over, setOver] = useState(false)
  const active = view === 'grid'

  return (
    <div className="px-2 pb-1 pt-2">
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
          active
            ? 'border-slate/50 bg-graphite text-chalk'
            : 'border-edge bg-panel text-ash hover:border-graphite hover:text-chalk'
        } ${over ? 'shadow-[inset_0_0_0_2px_var(--color-ash)]' : ''}`}
        onClick={() => setView(active ? 'focus' : 'grid')}
        data-testid="control-center-button"
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
        <span className="truncate font-medium tracking-tight">Control Center</span>
        {panels.length > 0 && <span className="readout ml-auto text-[10px] text-slate">{panels.length}</span>}
      </button>
    </div>
  )
}

/** 나뉜 화면 — 컨트롤 센터가 하는 일을 그대로 그린 기호 */
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
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const focusSession = useStore((s) => s.focusSession)
  const sessions = useSessionsOf(projectId)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const deleteSession = useStore((s) => s.deleteSession)
  const focusProject = useStore((s) => s.focusProject)
  const reorderProjects = useStore((s) => s.reorderProjects)
  const reorderSessions = useStore((s) => s.reorderSessions)
  const selected = useStore((s) => s.focusedProjectId === projectId && !s.focusedSessionId)

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
              onReorder={(draggedId, before) =>
                void reorderSessions(projectId, moveTo(sessions.map((x) => x.id), draggedId, s.id, before))
              }
            >
              <button
                onClick={() => focusSession(s.id)}
                data-testid={`session-row-${s.id}`}
                className={`flex w-full items-center gap-2 border-l-2 py-1.5 pl-2.5 pr-8 text-left text-[13px] transition-colors ${
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
                삭제 하나만 둔다.

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
            </SessionRow>
          )
        })}
      </ul>

      {newSessionOpen && <NewSessionDialog projectId={projectId} onClose={() => setNewSessionOpen(false)} />}

      {confirming && (
        <ConfirmDelete
          name={sessions.find((s) => s.id === confirming)?.name ?? 'Session'}
          // 프로젝트 기본값이 아니라 이 세션의 도구다 — 어디에 기록이 남는지 알려주는 문장이라 틀리면 안 된다
          tool={sessions.find((s) => s.id === confirming)?.tool ?? project.defaultTool}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            void deleteSession(confirming)
            setConfirming(null)
          }}
        />
      )}
    </section>
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
  name,
  tool,
  onConfirm,
  onCancel,
}: {
  name: string
  tool: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const toolLabel = tool === 'codex' ? 'Codex' : 'Claude Code'
  return (
    <Modal onClose={onCancel} testId="confirm-delete">
      <div className="w-[380px] max-w-[90vw] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]">
        <p className="text-[13px] text-chalk">Delete this session?</p>
        <p className="mt-1.5 truncate text-[12px] text-ash">{name}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate">
          Chat history and attachments in Control Center will be gone.
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-ash" data-testid="delete-notice">
          The conversation stays in {toolLabel} — you can pull it back from <span className="text-chalk">+ → Past conversations</span>.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk hover:border-graphite"
            onClick={onConfirm}
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
