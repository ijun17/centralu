import { useCallback, useEffect, useState } from 'react'
import type { GitCommit, GitFileStatus } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore, type PanelTab } from '../../store/store.js'
import { FileTree } from '../files/FileTree.jsx'

/**
 * 증거 레인 (우측).
 *
 * 세 레인의 역할이 서로 다르다:
 *   좌 = 관찰(무엇이 나를 기다리나) · 중앙 = 조작(말을 건다) · 우 = 증거(정말 그랬나)
 *
 * 여기 있는 것들은 대화를 **대신하는** 화면이 아니다. 에이전트가 "세 파일 고쳤습니다"라고
 * 말할 때 그 말을 확인하는 자리다. 그래서 중앙 탭이 아니라 옆에 함께 둔다.
 *
 * 자세히 보는 일(코드·diff·커밋)은 여기서 하지 않는다 — 340px에서 diff는 읽을 수 없다.
 * 클릭하면 넓은 오버레이가 대화 위에 펼쳐진다.
 */
export function EvidencePanel() {
  const open = useStore((s) => s.panelOpen)
  const projectId = useStore((s) => {
    const focused = s.focusedSessionId ? s.sessions[s.focusedSessionId]?.projectId : null
    return focused ?? s.focusedProjectId
  })
  const project = useStore((s) => (projectId ? s.projects[projectId] : undefined))

  if (!projectId || !project) return null
  // 닫혀 있어도 흔적은 남긴다 — 사라진 것과 접힌 것은 다르다
  if (!open) return <CollapsedRail projectId={projectId} isRepo={!!project.git} />

  return (
    <aside
      className="flex h-full w-[340px] shrink-0 flex-col overflow-hidden border-l border-edge bg-pit"
      data-testid="evidence-panel"
    >
      <PanelHeader projectName={project.name} branch={project.git?.branch ?? null} isRepo={!!project.git} />
      <PanelBody projectId={projectId} project={project} />
    </aside>
  )
}

function PanelHeader({
  projectName,
  branch,
  isRepo,
}: {
  projectName: string
  branch: string | null
  isRepo: boolean
}) {
  const tab = useStore((s) => s.panelTab)
  const setPanelTab = useStore((s) => s.setPanelTab)
  const togglePanel = useStore((s) => s.togglePanel)
  const openBranches = useStore((s) => s.openBranches)

  return (
    <>
      <header className="flex items-center gap-2 border-b border-edge px-3 py-2" data-tauri-drag-region>
        <span className="readout truncate text-[11px] text-ash" data-testid="evidence-project">
          {projectName}
        </span>
        {branch && (
          <button
            className="readout truncate text-[10px] text-slate transition-colors hover:text-chalk"
            onClick={openBranches}
            data-testid="evidence-branch"
            title="브랜치 전환"
          >
            {branch}
          </button>
        )}
        <button
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
          onClick={() => togglePanel(false)}
          data-testid="evidence-close"
          title="증거 패널 접기 (⌘B)"
        >
          ›
        </button>
      </header>

      <nav className="flex items-center gap-0.5 border-b border-edge px-2 py-1" data-testid="evidence-tabs">
        {(
          [
            ['git', '깃'],
            ['files', '파일'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setPanelTab(id as PanelTab)}
            data-testid={`evidence-tab-${id}`}
            disabled={id === 'git' && !isRepo}
            className={`rounded px-2 py-0.5 text-[12px] transition-colors disabled:opacity-40 ${
              tab === id ? 'bg-graphite/50 text-chalk' : 'text-ash hover:text-chalk'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
    </>
  )
}

function PanelBody({
  projectId,
  project,
}: {
  projectId: string
  project: { git?: { denied?: boolean } | null }
}) {
  const tab = useStore((s) => s.panelTab)
  const isRepo = !!project.git

  if (tab === 'files' || !isRepo) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'git' && !isRepo && (
          <p className="px-3 py-2 text-[11px] text-slate" data-testid="evidence-not-repo">
            git 저장소가 아닙니다
          </p>
        )}
        <FileTree projectId={projectId} />
      </div>
    )
  }

  // 깃 탭: 위는 지금 무엇이 바뀌었나, 아래는 어떻게 여기까지 왔나.
  // 둘 다 파일 목록이 아니라 서로 다른 질문이라서 나란히 둔다.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GitChanges projectId={projectId} denied={project.git?.denied} />
      <GitTree projectId={projectId} />
    </div>
  )
}

/** 패널을 접었을 때 남는 세로 띠. 어디로 갔는지 보이고, 변경 수는 접힌 채로도 읽힌다 */
function CollapsedRail({ projectId, isRepo }: { projectId: string; isRepo: boolean }) {
  const togglePanel = useStore((s) => s.togglePanel)
  const platform = usePlatform()
  const touched = useTouchedCount(projectId)
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    if (!isRepo) return setCount(null)
    platform.git
      .status(projectId)
      .then((f) => setCount(f.length))
      .catch(() => setCount(null))
  }, [platform, projectId, isRepo, touched])

  return (
    <aside
      className="flex h-full w-8 shrink-0 flex-col items-center gap-2 border-l border-edge bg-pit py-2"
      data-testid="evidence-rail"
    >
      <button
        className="rounded px-1 py-0.5 text-[12px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
        onClick={() => togglePanel(true)}
        data-testid="evidence-open"
        title="증거 패널 펴기 (⌘B)"
      >
        ‹
      </button>
      {count !== null && count > 0 && (
        <button
          className="readout rounded px-1 text-[10px] text-ash transition-colors hover:text-chalk"
          onClick={() => togglePanel(true)}
          data-testid="evidence-rail-count"
          title={`변경된 파일 ${count}개`}
        >
          {count}
        </button>
      )}
      {/* 세로쓰기 — 접힌 띠가 무엇의 띠인지 말해준다 */}
      <span
        className="mt-1 text-[10px] tracking-[0.2em] text-slate"
        style={{ writingMode: 'vertical-rl' }}
        aria-hidden
      >
        증거
      </span>
    </aside>
  )
}

/**
 * 변경된 파일 — 이 앱에서 가장 자주 보는 목록.
 * 목록과 커밋까지만 여기서 하고, diff는 넓은 곳에서 편다.
 */
function GitChanges({ projectId, denied }: { projectId: string; denied?: boolean }) {
  const platform = usePlatform()
  const openGit = useStore((s) => s.openGit)
  const setToast = useStore((s) => s.setToast)
  const touched = useTouchedCount(projectId)
  const [files, setFiles] = useState<GitFileStatus[] | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setFiles(await platform.git.status(projectId))
    } catch {
      setFiles([])
    }
  }, [platform, projectId])

  // 에이전트가 파일을 건드리면 다시 읽는다 (증거는 최신이어야 의미가 있다)
  useEffect(() => {
    void refresh()
  }, [refresh, touched])

  const unstaged = files?.filter((f) => !f.staged) ?? []
  const staged = files?.filter((f) => f.staged) ?? []

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex min-h-0 flex-[3] flex-col border-b border-edge" data-testid="evidence-git">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-[0.12em] text-slate">변경</span>
        {files && files.length > 0 && (
          <>
            <span className="readout text-[10px] text-ash" data-testid="evidence-change-count">
              {files.length}
            </span>
            <button
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate transition-colors hover:bg-graphite/50 hover:text-chalk"
              onClick={() => openGit()}
              data-testid="evidence-git-full"
              title="넓은 화면에서 보기"
            >
              넓게
            </button>
          </>
        )}
      </div>

      {denied ? (
        <p className="px-3 pb-2 text-[11px] leading-relaxed text-ash" data-testid="evidence-git-denied">
          폴더 접근 권한이 필요합니다 — 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더
        </p>
      ) : files === null ? (
        <p className="px-3 pb-2 text-[11px] text-slate">읽는 중…</p>
      ) : files.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] text-slate" data-testid="evidence-clean">
          변경 사항이 없습니다
        </p>
      ) : (
        <>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {[...staged, ...unstaged].map((f) => (
              <ChangeRow key={`${f.path}-${f.staged ? 's' : 'u'}`} file={f} onOpen={() => openGit(f.path)} />
            ))}
          </ul>

          {/* 커밋은 좁은 곳에서도 되어야 한다 — 확인하고 바로 마무리하는 흐름이 끊기면 안 된다 */}
          <div className="border-t border-edge px-3 py-2">
            {unstaged.length > 0 && (
              <button
                className="mb-1.5 w-full rounded border border-edge px-2 py-1 text-[11px] text-ash transition-colors hover:border-graphite hover:text-chalk disabled:opacity-40"
                disabled={busy}
                data-testid="evidence-stage-all"
                onClick={() =>
                  void run(() => platform.git.stage(projectId, unstaged.map((f) => f.path)))
                }
              >
                {unstaged.length}개 올리기
              </button>
            )}
            <input
              className="w-full rounded border border-edge bg-panel px-2 py-1 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
              placeholder="커밋 메시지"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              data-testid="evidence-commit-message"
            />
            <div className="mt-1.5 flex gap-1.5">
              <button
                className="flex-1 rounded border border-edge bg-panel px-2 py-1 text-[11px] text-chalk transition-colors hover:border-graphite disabled:opacity-40"
                disabled={busy || !message.trim() || staged.length === 0}
                data-testid="evidence-commit"
                onClick={() =>
                  void run(async () => {
                    const r = await platform.git.commit(projectId, message.trim())
                    setToast(r.ok ? '커밋했습니다' : (r.message ?? '커밋 실패'))
                    if (r.ok) setMessage('')
                  })
                }
              >
                커밋
              </button>
              <button
                className="rounded border border-edge px-2 py-1 text-[11px] text-ash transition-colors hover:border-graphite hover:text-chalk disabled:opacity-40"
                disabled={busy}
                data-testid="evidence-push"
                onClick={() =>
                  void run(async () => {
                    const r = await platform.git.push(projectId)
                    setToast(r.ok ? '푸시했습니다' : (r.message ?? '푸시 실패'))
                  })
                }
              >
                푸시
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function ChangeRow({ file, onOpen }: { file: GitFileStatus; onOpen: () => void }) {
  return (
    <li>
      <button
        className="flex w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-graphite/25"
        onClick={onOpen}
        data-testid={`evidence-file-${file.path}`}
        title={`${file.path} — diff 보기`}
      >
        {/* 종류는 색이 아니라 글자로 구분한다 (완전 무채색) */}
        <span className="readout w-3 shrink-0 text-[10px] text-ash">{file.status.slice(0, 1).toUpperCase()}</span>
        <span className="truncate text-[12px] text-ash" dir="rtl">
          {file.path}
        </span>
        {file.staged && <span className="readout ml-auto shrink-0 text-[9px] text-slate">올림</span>}
      </button>
    </li>
  )
}

/**
 * 깃 트리 — 어떻게 여기까지 왔나.
 * 그래프 선은 그리지 않는다: 340px에서 선을 그리면 제목이 설 자리가 없고,
 * 실제로 알고 싶은 건 '무엇이 언제 들어왔나'다. 병합만 표시한다.
 */
function GitTree({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const openCommit = useStore((s) => s.openCommit)
  const touched = useTouchedCount(projectId)
  const [commits, setCommits] = useState<GitCommit[] | null>(null)

  useEffect(() => {
    platform.git
      .log(projectId, 50)
      .then(setCommits)
      .catch(() => setCommits([]))
  }, [platform, projectId, touched])

  return (
    <section className="flex min-h-0 flex-[2] flex-col" data-testid="evidence-tree">
      <div className="px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-[0.12em] text-slate">기록</span>
      </div>
      {commits === null ? (
        <p className="px-3 pb-2 text-[11px] text-slate">읽는 중…</p>
      ) : commits.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] text-slate" data-testid="evidence-no-commits">
          커밋이 없습니다
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto pb-1" data-testid="evidence-commits">
          {commits.map((c, i) => (
            <li key={c.sha}>
              <button
                className="flex w-full items-start gap-2 px-3 py-1 text-left transition-colors hover:bg-graphite/25"
                onClick={() => openCommit(c.sha)}
                data-testid={`evidence-commit-${c.shortSha}`}
                title={`${c.subject} — ${c.author}`}
              >
                {/* 최신 하나만 채운 점. 나머지는 지나간 것이다 */}
                <span className="mt-1 shrink-0 text-[8px] text-slate" aria-hidden>
                  {i === 0 ? '●' : '○'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-ash">{c.subject}</span>
                  <span className="readout block truncate text-[10px] text-slate">
                    {c.shortSha} · {c.author}
                    {c.parents.length > 1 && ' · 병합'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 에이전트가 만진 파일 수 — 목록을 다시 읽을 시점을 아는 신호 */
function useTouchedCount(projectId: string): number {
  return useStore((s) => {
    let n = 0
    for (const sess of Object.values(s.sessions)) {
      if (sess.projectId === projectId) n += sess.touchedPaths.length
    }
    return n
  })
}
