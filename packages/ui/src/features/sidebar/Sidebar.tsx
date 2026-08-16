import { useState } from 'react'
import type { ProjectInfo } from '@cc/protocol'
import { useStore } from '../../store/store.js'
import { NewSessionDialog } from '../project/NewSessionDialog.jsx'
import { useHiddenSessionsOf, useSessionsOf } from '../../store/selectors.js'
import { StateDot, Tooltip } from '../../components/primitives.jsx'

/** 관찰 레인 — 밀도 높게, 공간은 조금만 (docs/architecture.md 설계 원칙 1) */
export function Sidebar() {
  const projectIds = useStore((s) => Object.keys(s.projects).join(','))
  const ids = projectIds ? projectIds.split(',') : []

  return (
    <aside
      className="flex h-full w-60 shrink-0 flex-col overflow-y-auto border-r border-edge bg-pit"
      data-testid="sidebar"
    >
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
  const [hiddenOpen, setHiddenOpen] = useState(false)
  const deleteSession = useStore((s) => s.deleteSession)
  const archive = useStore((s) => s.archive)
  const hidden = useHiddenSessionsOf(projectId)
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
                숨기기와 삭제는 다른 일이다.
                숨기기는 되돌릴 수 있고(기록이 남는다), 삭제는 되돌릴 수 없다.
                되돌릴 수 있는 쪽을 먼저·크게 두고, 삭제는 확인을 받는다.
              */}
              <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
                <button
                  className="rounded px-1 text-[11px] text-slate hover:text-chalk"
                  data-testid={`hide-session-${s.id}`}
                  title="목록에서 숨기기 (기록은 남고 나중에 다시 꺼낼 수 있습니다)"
                  aria-label={`${s.name} 숨기기`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void archive(s.id, true)
                  }}
                >
                  ⌄
                </button>
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

      {/* 숨긴 것은 사라진 게 아니다 — 몇 개인지 보이고, 펴면 되돌릴 수 있다 */}
      {hidden.length > 0 && (
        <div className="mt-1">
          <button
            className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[10px] text-slate transition-colors hover:text-ash"
            onClick={() => setHiddenOpen((v) => !v)}
            data-testid={`hidden-toggle-${project.name}`}
            aria-expanded={hiddenOpen}
          >
            <span className="text-[9px]">{hiddenOpen ? '▾' : '▸'}</span>
            숨김 {hidden.length}개
          </button>
          {hiddenOpen && (
            <ul data-testid={`hidden-list-${project.name}`}>
              {hidden.map((s) => (
                <li key={s.id} className="group/hidden relative">
                  <button
                    className="flex w-full items-center gap-2 py-1 pl-6 pr-14 text-left text-[12px] text-slate transition-colors hover:text-ash"
                    onClick={() => void archive(s.id, false)}
                    data-testid={`hidden-row-${s.id}`}
                    title="다시 꺼내기"
                  >
                    <span className="truncate">{s.name}</span>
                  </button>
                  <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/hidden:opacity-100">
                    <button
                      className="rounded px-1 text-[10px] text-slate hover:text-chalk"
                      onClick={() => void archive(s.id, false)}
                      data-testid={`unhide-session-${s.id}`}
                      aria-label={`${s.name} 다시 꺼내기`}
                      title="다시 꺼내기"
                    >
                      ⌃
                    </button>
                    <button
                      className="rounded px-1 text-[10px] text-slate hover:text-chalk"
                      onClick={() => setConfirming(s.id)}
                      data-testid={`delete-session-${s.id}`}
                      aria-label={`${s.name} 삭제`}
                      title="완전히 삭제"
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {newSessionOpen && <NewSessionDialog projectId={projectId} onClose={() => setNewSessionOpen(false)} />}

      {confirming && (
        <ConfirmDelete
          name={[...sessions, ...hidden].find((s) => s.id === confirming)?.name ?? '세션'}
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

/** 삭제 확인 — 기록까지 사라지므로 한 번 묻는다 */
function ConfirmDelete({
  name,
  onConfirm,
  onCancel,
}: {
  name: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-void/80 backdrop-blur-[2px]"
      onClick={onCancel}
      data-testid="confirm-delete"
    >
      <div
        className="w-[380px] max-w-[90vw] rounded-lg border border-edge bg-pit p-4 shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-[13px] text-chalk">세션을 삭제할까요?</p>
        <p className="mt-1.5 truncate text-[12px] text-ash">{name}</p>
        <p className="mt-1 text-[11px] text-slate">대화 기록과 첨부까지 사라집니다. 되돌릴 수 없습니다.</p>
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
    </div>
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
