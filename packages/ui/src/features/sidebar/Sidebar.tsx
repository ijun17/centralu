import { useState } from 'react'
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

function ProjectBlock({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId])
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const focusSession = useStore((s) => s.focusSession)
  const sessions = useSessionsOf(projectId)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const deleteSession = useStore((s) => s.deleteSession)
  const focusProject = useStore((s) => s.focusProject)
  const selected = useStore((s) => s.focusedProjectId === projectId && !s.focusedSessionId)

  if (!project) return null

  return (
    <section className="border-b border-edge/70 py-2.5" data-testid={`project-${project.name}`}>
      <header className="group flex items-baseline gap-2 px-3">
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
            <li key={s.id} className="group/row relative">
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
              <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
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
            </li>
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
        className={`readout flex size-[14px] items-center justify-center rounded-[3.5px] bg-chalk text-[9px] font-semibold leading-none text-void ${
          stalled ? 'opacity-50' : ''
        }`}
      >
        {tool === 'codex' ? 'X' : 'C'}
      </span>
    </span>
  )
}
