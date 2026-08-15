import { useState } from 'react'
import { useStore } from '../../store/store.js'
import { NewSessionDialog } from '../project/NewSessionDialog.jsx'
import { useSessionsOf } from '../../store/selectors.js'
import { StateDot } from '../../components/primitives.jsx'

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

  if (!project) return null

  return (
    <section className="border-b border-edge/70 py-2.5" data-testid={`project-${project.name}`}>
      <header className="group flex items-baseline gap-2 px-3">
        <h2 className="truncate text-[13px] font-medium tracking-tight text-chalk">{project.name}</h2>
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

      <div className="readout mt-0.5 flex items-center gap-1.5 px-3 text-[10px] text-slate">
        {project.git ? (
          <>
            <span className="truncate">{project.git.branch}</span>
            {project.git.changedFiles > 0 && (
              <span className="text-ash">{project.git.changedFiles}개 변경</span>
            )}
          </>
        ) : (
          <span>git 저장소 아님</span>
        )}
      </div>

      {/*
        동시 세션은 데이터 손실 위험 — 차단하지 않고 보이게 한다 (FR-2).
        단 밝게 쓰지 않는다: 밝기는 "지금 내 조치가 필요한 것"의 몫이고,
        이건 알아둘 정보다. 여기서 밝히면 진짜 신호가 묻힌다.
      */}
      {sessions.length > 1 && (
        <p
          className="mt-1 px-3 text-[10px] leading-tight text-slate"
          data-testid={`concurrent-${project.name}`}
          title="같은 디렉토리에서 여러 세션이 같은 파일을 고치면 변경이 유실될 수 있습니다"
        >
          동시 세션 {sessions.length}개
        </p>
      )}

      <ul className="mt-1.5">
        {sessions.map((s) => {
          const unread = s.lastSeq > s.lastReadSeq
          const focused = focusedSessionId === s.id
          return (
            <li key={s.id}>
              <button
                onClick={() => focusSession(s.id)}
                data-testid={`session-row-${s.id}`}
                className={`flex w-full items-center gap-2 border-l-2 py-1.5 pl-2.5 pr-3 text-left text-[13px] transition-colors ${
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
            </li>
          )
        })}
      </ul>

      {newSessionOpen && <NewSessionDialog projectId={projectId} onClose={() => setNewSessionOpen(false)} />}
    </section>
  )
}
