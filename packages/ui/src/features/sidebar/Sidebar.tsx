import { useState } from 'react'
import type { ProjectInfo } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { NewSessionDialog } from '../project/NewSessionDialog.jsx'
import { useSessionsOf } from '../../store/selectors.js'
import { StateDot, Tooltip } from '../../components/primitives.jsx'
import { ResizeHandle } from '../../components/ResizeHandle.jsx'
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
          등록된 프로젝트가 없습니다.
          <br />
          위의 <span className="text-ash">프로젝트 추가</span>로 시작하세요.
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
        <button
          className="ml-auto rounded px-1 text-[13px] leading-none text-slate opacity-0 transition-opacity group-hover:opacity-100 hover:text-chalk focus-visible:opacity-100"
          onClick={() => setNewSessionOpen(true)}
          title="새 세션"
          aria-label={`${project.name}에 새 세션`}
          data-testid={`new-session-${project.name}`}
        >
          +
        </button>
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
                <StateDot state={s.state} />
                <span className={`truncate ${unread && !focused ? 'text-chalk' : ''}`}>{s.name}</span>
                {unread && (
                  <span
                    className="ml-auto size-1 shrink-0 rounded-full bg-ash"
                    data-testid={`unread-${s.id}`}
                    title="읽지 않음"
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
                <button
                  className="rounded px-1 text-[11px] text-slate hover:text-chalk"
                  data-testid={`delete-session-${s.id}`}
                  title="완전히 삭제 (기록도 함께 사라집니다)"
                  aria-label={`${s.name} 삭제`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirming(s.id)
                  }}
                >
                  ✕
                </button>
              </span>
            </li>
          )
        })}
      </ul>

      {newSessionOpen && <NewSessionDialog projectId={projectId} onClose={() => setNewSessionOpen(false)} />}

      {confirming && (
        <ConfirmDelete
          name={sessions.find((s) => s.id === confirming)?.name ?? '세션'}
          tool={project.defaultTool}
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
        <p className="text-[13px] text-chalk">세션을 삭제할까요?</p>
        <p className="mt-1.5 truncate text-[12px] text-ash">{name}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate">
          Control Center의 대화 기록과 첨부가 사라집니다.
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-ash" data-testid="delete-notice">
          {toolLabel}에는 대화가 그대로 남습니다 — <span className="text-chalk">+ → 이전 대화</span>에서 다시
          가져올 수 있습니다.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={onCancel}>
            취소
          </button>
          <button
            className="rounded border border-edge bg-panel px-3 py-1 text-[12px] text-chalk hover:border-graphite"
            onClick={onConfirm}
            data-testid="confirm-delete-yes"
          >
            삭제
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
    <span className="readout ml-auto flex shrink-0 items-center gap-1.5 text-[10px] text-slate">
      {changed > 0 && (
        <span data-testid={`mark-changed-${project.name}`} title={`변경된 파일 ${changed}개`}>
          {changed}
        </span>
      )}
      {/* 겹친 사각형 = 같은 폴더에서 여럿이 일하는 중 */}
      {risky && (
        <span className="text-ash" data-testid={`concurrent-${project.name}`} title={`동시 세션 ${sessionCount}개`}>
          ⧉{sessionCount}
        </span>
      )}
      {denied && (
        <span className="text-ash" data-testid={`git-denied-${project.name}`} title="폴더 접근 권한 필요">
          !
        </span>
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
            폴더 접근 권한 필요 — 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더
          </span>
        ) : project.git ? (
          <>
            <span className="text-chalk">{project.git.branch}</span>
            {project.git.changedFiles > 0 && <span> · {project.git.changedFiles}개 변경</span>}
          </>
        ) : (
          <span>git 저장소 아님</span>
        )}
      </span>
      {sessionCount > 1 && (
        <span className="mt-1 block text-chalk" data-testid="concurrent-detail">
          동시 세션 {sessionCount}개 — 같은 파일을 고치면 변경이 유실될 수 있습니다
        </span>
      )}
    </span>
  )
}
