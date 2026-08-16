import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitBranch, GitCommit, GitFileStatus } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'

type SubTab = 'changes' | 'history' | 'branches'

/**
 * 깃 패널 (FR-4, B-2~B-6).
 * 승인 판단의 근거를 앱 안에서 만든다 — 이걸 보려고 IDE로 나가지 않아도 되게.
 */
export function GitPanel({ projectId, initialPath }: { projectId: string; initialPath?: string | null }) {
  const [sub, setSub] = useState<SubTab>('changes')
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="git-panel">
      <nav className="flex items-center gap-0.5 border-b border-edge px-2 py-1">
        {(
          [
            ['changes', '변경'],
            ['history', '기록'],
            ['branches', '브랜치'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSub(id)}
            data-testid={`git-sub-${id}`}
            className={`rounded px-2 py-0.5 text-[12px] transition-colors ${
              sub === id ? 'bg-graphite/50 text-chalk' : 'text-ash hover:text-chalk'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      {sub === 'changes' && <Changes projectId={projectId} initialPath={initialPath} />}
      {sub === 'history' && <History projectId={projectId} />}
      {sub === 'branches' && <Branches projectId={projectId} />}
    </section>
  )
}

/** B-2 변경 탭 + B-6 스테이징·커밋·푸시 */
function Changes({ projectId, initialPath }: { projectId: string; initialPath?: string | null }) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const openFile = useStore((s) => s.openFile)
  const touched = useTouchedPaths(projectId)
  const [files, setFiles] = useState<GitFileStatus[] | null>(null)
  const [selected, setSelected] = useState<GitFileStatus | null>(null)
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean; binary: boolean } | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setFiles(await platform.git.status(projectId))
    } catch {
      setFiles([])
    }
  }, [platform, projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 에이전트가 파일을 바꾸면 목록을 갱신한다 (touched 경로가 늘어난 것이 신호)
  useEffect(() => {
    void refresh()
  }, [touched.length, refresh])

  const openDiff = useCallback(
    async (f: GitFileStatus) => {
      setSelected(f)
      setDiff(await platform.git.diff(projectId, f.path, f.staged))
    },
    [platform, projectId],
  )

  // 우측 패널에서 파일을 눌러 들어온 경우 그 diff부터 펴 준다 —
  // 넓은 화면에 와서 목록을 다시 찾게 하면 클릭 한 번이 헛돈다
  useEffect(() => {
    if (!initialPath || !files || selected) return
    const hit = files.find((f) => f.path === initialPath)
    if (hit) void openDiff(hit)
  }, [initialPath, files, selected, openDiff])

  const staged = files?.filter((f) => f.staged) ?? []
  const unstaged = files?.filter((f) => !f.staged) ?? []

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-edge">
        {files === null ? (
          <p className="p-3 text-[12px] text-slate">읽는 중…</p>
        ) : files.length === 0 ? (
          <p className="p-3 text-[12px] text-slate" data-testid="git-clean">
            변경 사항이 없습니다
          </p>
        ) : (
          <>
            <FileGroup
              title="스테이지됨"
              files={staged}
              touched={touched}
              onOpen={openDiff}
              selected={selected}
              action={{
                label: '내리기',
                run: async (paths) => {
                  await platform.git.stage(projectId, paths, true)
                  await refresh()
                },
              }}
            />
            <FileGroup
              title="변경됨"
              files={unstaged}
              touched={touched}
              onOpen={openDiff}
              selected={selected}
              action={{
                label: '올리기',
                run: async (paths) => {
                  await platform.git.stage(projectId, paths)
                  await refresh()
                },
              }}
            />
          </>
        )}

        {staged.length > 0 && (
          <form
            className="mt-auto border-t border-edge p-2"
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              const res = await platform.git.commit(projectId, message.trim())
              setBusy(false)
              if (res.ok) {
                setMessage('')
                setToast(`${staged.length}개 파일을 커밋했습니다`)
                await refresh()
              } else setToast(res.message ?? '커밋하지 못했습니다')
            }}
          >
            <textarea
              className="w-full resize-none rounded border border-edge bg-panel px-2 py-1.5 text-[12px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="커밋 메시지"
              data-testid="commit-message"
            />
            <div className="mt-1.5 flex gap-1.5">
              <button
                className="flex-1 rounded border border-edge bg-panel px-2 py-1 text-[12px] text-chalk hover:border-graphite disabled:opacity-40"
                disabled={busy || !message.trim()}
                data-testid="commit-button"
              >
                커밋 ({staged.length})
              </button>
              <button
                type="button"
                className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk"
                data-testid="push-button"
                onClick={async () => {
                  const res = await platform.git.push(projectId)
                  setToast(res.ok ? '푸시했습니다' : (res.message ?? '푸시하지 못했습니다'))
                }}
              >
                푸시
              </button>
            </div>
          </form>
        )}
      </div>

      <DiffView
        path={selected?.path}
        data={diff}
        onOpenInIde={async (line) => {
          if (selected) await platform.system.openInIde(selected.path, line)
        }}
        onOpenViewer={selected ? () => openFile(selected.path) : undefined}
      />
    </div>
  )
}

function FileGroup({
  title,
  files,
  touched,
  onOpen,
  selected,
  action,
}: {
  title: string
  files: GitFileStatus[]
  touched: string[]
  onOpen: (f: GitFileStatus) => void
  selected: GitFileStatus | null
  action: { label: string; run: (paths: string[]) => Promise<void> }
}) {
  if (files.length === 0) return null
  return (
    <div className="border-b border-edge/60">
      <header className="flex items-center gap-2 px-2.5 py-1.5">
        <h3 className="text-[10px] uppercase tracking-[0.12em] text-slate">{title}</h3>
        <span className="readout text-[10px] text-slate">{files.length}</span>
        <button
          className="ml-auto text-[10px] text-slate hover:text-chalk"
          onClick={() => void action.run(files.map((f) => f.path))}
          data-testid={`git-${action.label}-all`}
        >
          모두 {action.label}
        </button>
      </header>
      <ul>
        {files.map((f) => (
          <li key={`${f.path}-${f.staged}`}>
            <button
              onClick={() => onOpen(f)}
              data-testid={`git-file-${f.path}`}
              className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] transition-colors ${
                selected?.path === f.path ? 'bg-graphite/40 text-chalk' : 'text-ash hover:text-chalk'
              }`}
            >
              {/* 상태는 색이 아니라 글자로 (무채색 규칙) */}
              <span className="readout w-3 shrink-0 text-[10px] text-slate">{f.status}</span>
              <span className="truncate">{f.path}</span>
              {/* 에이전트가 만진 파일 — 내가 고친 것과 구분한다 (B-7) */}
              {touched.includes(f.path) && (
                <span className="ml-auto shrink-0 text-[9px] text-slate" title="에이전트가 수정함">
                  ◆
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * diff 뷰 — **무채색 결정 적용** (m2-plan 결정 1).
 * 색 대신 배경 밝기 2단과 `+`/`-` 기호로 추가·삭제를 구분한다.
 */
function DiffView({
  path,
  data,
  onOpenInIde,
  onOpenViewer,
}: {
  path?: string
  data: { diff: string; truncated: boolean; binary: boolean } | null
  onOpenInIde: (line?: number) => Promise<void>
  onOpenViewer?: () => void
}) {
  if (!path) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-slate" data-testid="diff-empty">
        파일을 선택하면 변경 내용을 보여줍니다
      </div>
    )
  }
  if (data?.binary) {
    return <div className="flex flex-1 items-center justify-center text-[12px] text-slate">바이너리 파일입니다</div>
  }

  const lines = (data?.diff ?? '').split('\n')
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="diff-view">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <span className="readout truncate text-[11px] text-ash">{path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {onOpenViewer && (
            <button className="text-[11px] text-slate hover:text-chalk" onClick={onOpenViewer} data-testid="open-in-viewer">
              전체 보기
            </button>
          )}
          <button className="text-[11px] text-slate hover:text-chalk" onClick={() => void onOpenInIde()} data-testid="open-in-ide">
            IDE에서 열기
          </button>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[1.5]">
        {lines.map((line, i) => {
          const kind = line.startsWith('+') && !line.startsWith('+++') ? 'add'
            : line.startsWith('-') && !line.startsWith('---') ? 'del'
            : line.startsWith('@@') ? 'hunk'
            : 'ctx'
          return (
            <div
              key={i}
              data-diff={kind}
              className={
                kind === 'add' ? 'bg-graphite/50 text-chalk'
                : kind === 'del' ? 'bg-panel text-slate line-through decoration-slate/40'
                : kind === 'hunk' ? 'bg-panel/60 text-ash'
                : 'text-ash'
              }
            >
              <span className="inline-block w-4 select-none text-center text-slate">
                {kind === 'add' ? '+' : kind === 'del' ? '−' : ''}
              </span>
              {line.replace(/^[+-]/, '')}
            </div>
          )
        })}
        {data?.truncated && (
          <p className="p-2 text-[11px] text-slate">…변경이 너무 커서 일부만 표시합니다. IDE에서 열어 확인하세요.</p>
        )}
      </div>
    </div>
  )
}

/** B-3 기록 탭 — 그래프 선은 그리지 않는다 (부모 관계만) */
function History({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const [commits, setCommits] = useState<GitCommit[] | null>(null)
  const [detail, setDetail] = useState<{ sha: string; files: string[]; diff: string } | null>(null)

  useEffect(() => {
    void platform.git.log(projectId, 50).then(setCommits).catch(() => setCommits([]))
  }, [platform, projectId])

  return (
    <div className="flex min-h-0 flex-1">
      <ul className="w-80 shrink-0 overflow-y-auto border-r border-edge" data-testid="git-history">
        {(commits ?? []).map((c) => (
          <li key={c.sha}>
            <button
              className={`flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left transition-colors ${
                detail?.sha === c.sha ? 'bg-graphite/40' : 'hover:bg-graphite/20'
              }`}
              data-testid={`commit-${c.shortSha}`}
              onClick={async () => {
                const d = await platform.git.commitDetail(projectId, c.sha)
                setDetail({ sha: c.sha, files: d.files, diff: d.diff })
              }}
            >
              <span className="truncate text-[12px] text-chalk">{c.subject}</span>
              <span className="readout text-[10px] text-slate">
                {c.shortSha} · {c.author} · {new Date(c.when).toLocaleDateString('ko-KR')}
                {c.parents.length > 1 && ' · 병합'}
              </span>
            </button>
          </li>
        ))}
        {commits?.length === 0 && <li className="p-3 text-[12px] text-slate">커밋이 없습니다</li>}
      </ul>
      <DiffView path={detail ? `${detail.files.length}개 파일` : undefined} data={detail ? { diff: detail.diff, truncated: false, binary: false } : null} onOpenInIde={async () => {}} />
    </div>
  )
}

/** B-4 브랜치 탭 — 더티 상태여도 막지 않고 무엇이 걸리는지 먼저 보여준다 */
function Branches({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  const [pending, setPending] = useState<{ branch: string; conflicts: string[] } | null>(null)

  const load = useCallback(() => {
    void platform.git.branches(projectId).then(setBranches).catch(() => setBranches([]))
  }, [platform, projectId])
  useEffect(load, [load])

  const attempt = async (branch: string) => {
    const dry = await platform.git.checkout(projectId, branch, true)
    if (!dry.ok && dry.conflicts.length > 0) {
      setPending({ branch, conflicts: dry.conflicts })
      return
    }
    await doCheckout(branch)
  }

  const doCheckout = async (branch: string) => {
    const res = await platform.git.checkout(projectId, branch)
    setPending(null)
    if (res.ok) {
      setToast(`${branch}로 전환했습니다`)
      load()
    } else setToast(res.message ?? '전환하지 못했습니다')
  }

  const local = (branches ?? []).filter((b) => !b.name.startsWith('remotes/'))
  const remote = (branches ?? []).filter((b) => b.name.startsWith('remotes/'))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="git-branches">
      {pending && (
        <div className="border-b border-edge bg-panel p-3" data-testid="checkout-warning">
          <p className="text-[12px] text-chalk">
            {pending.branch}로 전환하면 아래 변경이 영향을 받을 수 있습니다.
          </p>
          <ul className="readout mt-1.5 max-h-24 overflow-y-auto text-[11px] text-ash">
            {pending.conflicts.slice(0, 10).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div className="mt-2 flex gap-1.5">
            <button
              className="rounded border border-edge bg-panel px-2 py-1 text-[12px] text-chalk hover:border-graphite"
              onClick={() => void doCheckout(pending.branch)}
              data-testid="checkout-proceed"
            >
              그래도 전환
            </button>
            <button className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={() => setPending(null)}>
              취소
            </button>
          </div>
        </div>
      )}
      <BranchList title="로컬" branches={local} onPick={attempt} />
      <BranchList title="원격" branches={remote} onPick={attempt} />
    </div>
  )
}

function BranchList({ title, branches, onPick }: { title: string; branches: GitBranch[]; onPick: (b: string) => void }) {
  if (branches.length === 0) return null
  return (
    <div className="border-b border-edge/60">
      <h3 className="px-2.5 py-1.5 text-[10px] uppercase tracking-[0.12em] text-slate">{title}</h3>
      <ul>
        {branches.map((b) => (
          <li key={b.name}>
            <button
              className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] transition-colors ${
                b.current ? 'text-chalk' : 'text-ash hover:text-chalk'
              }`}
              onClick={() => !b.current && onPick(b.name)}
              data-testid={`branch-${b.name}`}
            >
              <span className="w-2.5 shrink-0 text-center text-[9px] text-slate">{b.current ? '●' : ''}</span>
              <span className="truncate">{b.name.replace(/^remotes\//, '')}</span>
              {b.upstream && <span className="readout ml-auto shrink-0 text-[10px] text-slate">→ {b.upstream}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 이 프로젝트의 세션들이 만진 파일 (B-7).
 * 셀렉터가 매번 새 배열을 만들면 zustand 스냅샷이 불안정해져 무한 리렌더가 난다
 * (docs/state-management.md §3 — 파생 계산은 use* 훅에서 memo화한다).
 */
function useTouchedPaths(projectId: string): string[] {
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => {
    const set = new Set<string>()
    for (const sess of Object.values(sessions)) {
      if (sess.projectId === projectId) for (const p of sess.touchedPaths) set.add(p)
    }
    return [...set]
  }, [sessions, projectId])
}

