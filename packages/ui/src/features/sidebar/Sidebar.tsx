import { useStore } from '../../store/store.js'
import { useSessionsOf } from '../../store/selectors.js'
import { StateDot } from '../../components/primitives.jsx'

/** 관찰 레인 — 밀도 높게, 공간은 조금만 (docs/architecture.md 설계 원칙 1) */
export function Sidebar() {
  const projectIds = useStore((s) => Object.keys(s.projects).join(','))
  const ids = projectIds ? projectIds.split(',') : []

  return (
    <aside
      className="flex h-full w-64 shrink-0 flex-col overflow-y-auto border-r border-neutral-800 bg-neutral-950 text-sm"
      data-testid="sidebar"
    >
      {ids.length === 0 && <p className="p-4 text-xs text-neutral-500">프로젝트를 등록하세요</p>}
      {ids.map((id) => (
        <ProjectBlock key={id} projectId={id} />
      ))}
    </aside>
  )
}

function ProjectBlock({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects[projectId])
  const focusedSessionId = useStore((s) => s.focusedSessionId)
  const focusSession = useStore((s) => s.focusSession)
  const createSession = useStore((s) => s.createSession)
  const sessions = useSessionsOf(projectId)

  if (!project) return null

  return (
    <div className="border-b border-neutral-900 py-2" data-testid={`project-${project.name}`}>
      <div className="flex items-center justify-between px-3 py-1">
        <span className="truncate font-medium text-neutral-200">{project.name}</span>
        <button
          className="rounded px-1 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          onClick={() => void createSession(projectId)}
          title="새 세션"
          data-testid={`new-session-${project.name}`}
        >
          ＋
        </button>
      </div>
      <div className="px-3 text-[11px] text-neutral-500">
        {project.git ? `${project.git.branch} · ${project.git.changedFiles} changed` : '(git 아님)'}
        {/* 동시 세션은 데이터 손실 위험 — 차단하지 않고 보이게 한다 (FR-2) */}
        {sessions.length > 1 && (
          <span className="ml-1 text-amber-500" data-testid={`concurrent-${project.name}`}>
            · 동시 세션 {sessions.length}개
          </span>
        )}
      </div>
      <ul className="mt-1">
        {sessions.map((s) => {
          const unread = s.lastSeq > s.lastReadSeq
          return (
            <li key={s.id}>
              <button
                onClick={() => focusSession(s.id)}
                data-testid={`session-row-${s.id}`}
                className={`flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-neutral-900 ${
                  focusedSessionId === s.id ? 'bg-neutral-900' : ''
                }`}
              >
                <StateDot state={s.state} />
                <span className={`truncate ${unread ? 'font-semibold text-neutral-100' : 'text-neutral-400'}`}>
                  {s.name}
                </span>
                {unread && (
                  <span className="ml-auto text-[10px] text-sky-400" data-testid={`unread-${s.id}`}>
                    ●
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
