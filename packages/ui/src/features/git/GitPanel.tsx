import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitBranch, GitFileStatus } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { selectedText } from '../viewer/copy.js'

type SubTab = 'changes' | 'history' | 'branches'
type DiffRowKind = 'file' | 'add' | 'del' | 'hunk' | 'ctx'
type DiffRow = { readonly kind: DiffRowKind; readonly marker: string; readonly body: string }

const MAX_RENDERED_DIFF_ROWS = 1_000
const DIFF_TRUNCATED_MESSAGE = '…diff is too large; showing part of it. Open in your IDE to see the rest.'

function toDiffRow(line: string): DiffRow {
  const kind: DiffRowKind = line.startsWith('diff --git ') ? 'file'
    : line.startsWith('+') && !line.startsWith('+++') ? 'add'
    : line.startsWith('-') && !line.startsWith('---') ? 'del'
    : line.startsWith('@@') ? 'hunk'
    : 'ctx'
  const marked = kind === 'add' || kind === 'del'
  // The clipboard gets the ASCII marker. The screen gets the typographic one, below.
  return { kind, marker: marked ? line.charAt(0) : '', body: marked ? line.slice(1) : line }
}

function renderableDiffRows(diff: string): { readonly rows: readonly DiffRow[]; readonly rowClipped: boolean } {
  const lines = diff.split('\n', MAX_RENDERED_DIFF_ROWS + 1)
  const rowClipped = lines.length > MAX_RENDERED_DIFF_ROWS
  const visibleLines = rowClipped ? lines.slice(0, MAX_RENDERED_DIFF_ROWS) : lines
  return { rows: visibleLines.map(toDiffRow), rowClipped }
}

/**
 * 깃 패널 (FR-4, B-2~B-6).
 * 승인 판단의 근거를 앱 안에서 만든다 — 이걸 보려고 IDE로 나가지 않아도 되게.
 *
 * Everything named `initial*` here used to mean exactly that: read once at mount, because
 * the panel was born from the click that carried it. It is not, any more — the change list
 * on the right stays visible while this is open (#15), so clicks keep arriving at a panel
 * that is already mounted, and a value read once is a value ignored from then on. `pick`
 * says which click these fields belong to, so each one lands.
 */
export function GitPanel({
  projectId,
  initialPath,
  initialSha,
  initialSub,
  pick,
}: {
  projectId: string
  initialPath?: string | null
  initialSha?: string | null
  initialSub?: SubTab
  pick: number
}) {
  /*
   * 탭 스트립은 없다 (사용자 요청 2026-09-07). Changes·History·Branches 진입점은
   * 우측 증거 사이드바가 이미 전부 갖고 있고(#15로 오버레이 중에도 보인다),
   * 여기 또 있으면 같은 문 세 개가 두 벌이다. 이 화면은 **눌러서 들어온 그것**만
   * 보여준다 — 어느 화면인지는 상태가 아니라 클릭(initialSub)에서 파생된다.
   */
  const sub: SubTab = initialSub ?? 'changes'

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="git-panel">
      {sub === 'changes' && <Changes projectId={projectId} initialPath={initialPath} pick={pick} />}
      {sub === 'history' && <History projectId={projectId} initialSha={initialSha} pick={pick} />}
      {sub === 'branches' && <Branches projectId={projectId} />}
    </section>
  )
}

/**
 * B-2 변경 diff — **목록·스테이징·커밋은 우측 사이드바의 몫이다** (2026-09-07 좌측 열 제거).
 *
 * 파일 목록이 여기 또 있었는데, 사이드바의 Changes가 같은 목록을 이미 들고 있고
 * 오버레이 중에도 보인다(#15) — 같은 목록 두 벌은 어느 쪽을 눌러야 하는지부터
 * 헷갈리게 했다 (사용자 지적). 이 화면은 넓어야 하는 것 하나, diff만 그린다.
 * staged 여부는 목록 없이도 필요하므로 status에서 그 파일만 찾는다.
 */
function Changes({
  projectId,
  initialPath,
  pick,
}: {
  projectId: string
  initialPath?: string | null
  pick: number
}) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const openFile = useStore((s) => s.openFile)
  const [selected, setSelected] = useState<GitFileStatus | null>(null)
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean; binary: boolean } | null>(null)

  /*
   * 요청 세대 번호. 이 diff는 **승인 판단의 근거**다 — 파일을 연달아 누르면 느린 응답이
   * 나중에 도착해, 지금 보고 있는 파일 이름 아래 **다른 파일의 diff**가 그려질 수 있다.
   * 마지막 요청만 화면을 쓸 수 있게 한다.
   */
  const diffGen = useRef(0)
  const openDiff = useCallback(
    async (f: GitFileStatus) => {
      const gen = ++diffGen.current
      setSelected(f)
      setDiff(null) // 옛 파일의 diff를 새 파일 이름 아래 남겨 두지 않는다
      try {
        const d = await platform.git.diff(projectId, f.path, f.staged)
        if (gen === diffGen.current) setDiff(d)
      } catch (e) {
        if (gen === diffGen.current) setToast(`Could not load diff: ${(e as Error).message}`)
      }
    },
    [platform, projectId, setToast],
  )

  // 사이드바 클릭을 따라간다 — pick마다 한 번. 재클릭이 곧 재시도다
  const opened = useRef(-1)
  useEffect(() => {
    if (!initialPath || opened.current === pick) return
    opened.current = pick
    let alive = true
    void platform.git
      .status(projectId)
      .then((files) => {
        if (!alive) return
        const hit = files.find((f) => f.path === initialPath)
        if (hit) void openDiff(hit)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [pick, initialPath, platform, projectId, openDiff])

  return (
    <div className="flex min-h-0 flex-1">
      <DiffView
        path={selected?.path}
        data={diff}
        emptyHint="Pick a file from the Changes list on the right"
        onOpenInIde={async (line) => {
          if (selected) await platform.system.openInIde(selected.path, line)
        }}
        onOpenViewer={selected ? () => openFile(selected.path) : undefined}
      />
    </div>
  )
}

/**
 * diff 뷰.
 *
 * 여기만 유채색을 쓴다 (m2-plan 결정 1의 예외 — styles/index.css의 --color-add/del 참고).
 * 추가는 초록, 삭제는 빨강. 무채색으로도 `+`/`-`와 밝기로 구분은 되지만,
 * 승인 판단은 훑어보며 하는 일이라 한 줄씩 읽게 만들면 그 흐름이 끊긴다.
 * 기호는 그대로 둔다 — 색을 못 보는 사람에게 색만 남기면 정보가 사라진다.
 *
 * Copying needs the viewer's handler (issue #36), for the opposite reason to the viewer's.
 * Nothing here is virtualized, so the shown rows are in the DOM — but the markers are drawn
 * in their own `select-none` span, and here the browser honours that and drops them: a
 * copied diff came back with added and removed lines looking identical. The screen's − is a
 * typographic minus anyway, which no patch tool accepts. So the payload is rebuilt from the
 * data, marker included, and one `onCopy` on the scrolling element is enough — a selection
 * that cannot lose its rows cannot be walked out of them either.
 */
function DiffView({
  path,
  data,
  emptyHint,
  onOpenInIde,
  onOpenViewer,
}: {
  path?: string
  data: { diff: string; truncated: boolean; binary: boolean } | null
  /** 아무것도 안 고른 채 열렸을 때 — 목록이 사이드바에 있으니 그쪽을 가리켜야 한다 */
  emptyHint?: string
  onOpenInIde: (line?: number) => Promise<void>
  onOpenViewer?: () => void
}) {
  if (!path) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px] text-slate" data-testid="diff-empty">
        {emptyHint ?? 'Select a file to see its diff'}
      </div>
    )
  }
  if (data?.binary) {
    return <div className="flex flex-1 items-center justify-center text-[12px] text-slate">Binary file</div>
  }

  /**
   * Each line split the way it is drawn: the marker moves into its own span, `body` is what
   * is left. Splitting it once here is what lets the copy handler below put the line back
   * together — and it stops `--- a/foo` from losing a dash, which the old blanket
   * `replace(/^[+-]/, '')` did to every file header, since the classifier calls those
   * context lines.
   */
  const { rows, rowClipped } = renderableDiffRows(data?.diff ?? '')
  const truncated = Boolean(data?.truncated) || rowClipped

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="diff-view">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <span className="readout truncate text-[11px] text-ash">{path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {onOpenViewer && (
            <button className="text-[11px] text-slate hover:text-chalk" onClick={onOpenViewer} data-testid="open-in-viewer">
              Show all
            </button>
          )}
          <button className="text-[11px] text-slate hover:text-chalk" onClick={() => void onOpenInIde()} data-testid="open-in-ide">
            Open in IDE
          </button>
        </span>
      </header>
      <div
        className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[1.5]"
        onCopy={(e) => {
          const payload = selectedText({
            selection: document.getSelection(),
            root: e.currentTarget,
            lines: rows.map((r) => ({ text: r.body, prefix: r.marker })),
            lastAnchor: null,
          })
          if (payload === null) return
          e.preventDefault()
          e.clipboardData.setData('text/plain', payload)
        }}
      >
        {rows.map(({ kind, body }, i) => {
          /*
           * 파일 경계 밴드 (사용자 선택 2026-09-07 — 커밋 diff는 여러 파일이 한 텍스트라
           * 어디서 다음 파일이 시작되는지 안 보였다). sticky라 스크롤 중에도 "지금 보는
           * 파일"이 위에 남는다. 화면에는 경로만 그리지만 data-line은 그대로라, 복사는
           * 여전히 원문 `diff --git` 줄을 낸다 (#36의 재구성 방식 덕 — 표시≠복사).
           */
          if (kind === 'file') {
            const m = /^diff --git a\/(.*) b\/(.*)$/.exec(body)
            const label = m ? (m[1] === m[2] ? m[2] : `${m[1]} → ${m[2]}`) : body
            return (
              <div
                key={i}
                data-diff="file"
                data-line={i}
                data-testid="diff-file-band"
                className="sticky top-0 z-10 border-b border-edge bg-panel px-3 py-1"
              >
                <span data-code className="readout text-[11px] text-chalk">
                  {label}
                </span>
              </div>
            )
          }
          return (
            <div
              key={i}
              data-diff={kind}
              data-line={i}
              className={
                kind === 'add' ? 'bg-add-bg text-add'
                : kind === 'del' ? 'bg-del-bg text-del'
                : kind === 'hunk' ? 'bg-panel/60 text-ash'
                : 'text-ash'
              }
            >
              <span className="inline-block w-4 select-none text-center opacity-70">
                {kind === 'add' ? '+' : kind === 'del' ? '−' : ''}
              </span>
              <span data-code>{body}</span>
            </div>
          )
        })}
        {truncated && (
          <p className="p-2 text-[11px] text-slate" data-testid="diff-truncation">
            {DIFF_TRUNCATED_MESSAGE}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * B-3 커밋 상세 — **목록은 사이드바 History의 몫이다** (2026-09-07 좌측 열 제거).
 * 사이드바에서 커밋을 누르면 그 diff가 여기 넓게 펴진다. 다음 커밋도 사이드바에서 —
 * 같은 목록 두 벌은 혼동이다 (Changes와 같은 판정).
 */
function History({ projectId, initialSha, pick }: { projectId: string; initialSha?: string | null; pick: number }) {
  const platform = usePlatform()
  const [detail, setDetail] = useState<{ sha: string; files: string[]; diff: string; truncated: boolean } | null>(null)

  const opened = useRef(-1)
  useEffect(() => {
    if (!initialSha || opened.current === pick) return
    opened.current = pick
    void platform.git
      .commitDetail(projectId, initialSha)
      .then((d) => setDetail({ sha: initialSha, files: d.files, diff: d.diff, truncated: d.truncated }))
      .catch(() => {})
  }, [pick, initialSha, platform, projectId])

  return (
    <div className="flex min-h-0 flex-1">
      <DiffView
        path={detail ? `${detail.files.length} files` : undefined}
        data={detail ? { diff: detail.diff, truncated: detail.truncated, binary: false } : null}
        emptyHint="Pick a commit from the History list on the right"
        onOpenInIde={async () => {}}
      />
    </div>
  )
}

/** B-4 브랜치 탭 — 더티 상태여도 막지 않고 무엇이 걸리는지 먼저 보여준다 */
function Branches({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  // The one write here moves the branch **name** the sidebar prints, so it goes through the
  // store too (issue #49) — the dry run beside it changes nothing and stays a plain read.
  const gitCheckout = useStore((s) => s.gitCheckout)
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
    const res = await gitCheckout(projectId, branch)
    setPending(null)
    if (res.ok) {
      setToast(`Switched to ${branch}`)
      load()
    } else setToast(res.message ?? 'Could not switch')
  }

  const local = (branches ?? []).filter((b) => !b.name.startsWith('remotes/'))
  const remote = (branches ?? []).filter((b) => b.name.startsWith('remotes/'))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="git-branches">
      {pending && (
        <div className="border-b border-edge bg-panel p-3" data-testid="checkout-warning">
          <p className="text-[12px] text-chalk">
            Switching to {pending.branch} may affect the changes below.
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
              Switch anyway
            </button>
            <button className="rounded px-2 py-1 text-[12px] text-slate hover:text-chalk" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <BranchList title="Local" branches={local} onPick={attempt} />
      <BranchList title="Remote" branches={remote} onPick={attempt} />
    </div>
  )
}

function BranchList({ title, branches, onPick }: { title: string; branches: GitBranch[]; onPick: (b: string) => void }) {
  if (branches.length === 0) return null
  return (
    <div className="border-b border-edge/60">
      <h3 className="px-2.5 py-1.5 text-[10px] uppercase text-slate">{title}</h3>
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
