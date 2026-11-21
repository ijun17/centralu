import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { errorMessage, type GitBranch, type GitFileStatus } from '@cc/protocol/client'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useLoad } from '../../app/useLoad.js'
import { LoadFailed } from '../../components/LoadFailed.jsx'
import { useStore } from '../../store/store.js'
import { useProjectMachine } from '../../store/selectors.js'
import { useRemoteIde } from '../machines/remoteIde.js'
import { useVirtualCopy } from '../viewer/useVirtualCopy.js'
import { Button } from '../../components/Button.jsx'
import { Badge } from '../../components/Badge.jsx'
import { diffFileLabel, diffPlaceAt, renderableDiffRows, type DiffPlace } from './diff.js'

type SubTab = 'changes' | 'history' | 'branches'

const DIFF_TRUNCATED_MESSAGE = '…diff is too large; showing part of it. Open in your IDE to see the rest.'

/**
 * Git panel (FR-4, B-2 through B-6): the basis for an approval decision, without leaving for the IDE. No `initial*`
 * is read only at mount: the change list stays visible while this is open (#15), so clicks keep arriving; `pick` says
 * which click the fields belong to.
 */
export function GitPanel({
  projectId,
  initialPath,
  initialStaged,
  initialSha,
  initialSub,
  pick,
}: {
  projectId: string
  initialPath?: string | null
  initialStaged?: boolean
  initialSha?: string | null
  initialSub?: SubTab
  pick: number
}) {
  /*
   * No tab strip: Changes, History and Branches are in the evidence sidebar, visible over this (#15), and two copies of
   * each door would confuse. The screen is the one clicked into (initialSub), not state.
   */
  const sub: SubTab = initialSub ?? 'changes'

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="git-panel">
      {sub === 'changes' && (
        <Changes projectId={projectId} initialPath={initialPath} initialStaged={initialStaged} pick={pick} />
      )}
      {sub === 'history' && <History projectId={projectId} initialSha={initialSha} pick={pick} />}
      {sub === 'branches' && <Branches projectId={projectId} />}
    </section>
  )
}

/**
 * B-2 change diff, only the diff: the list, staging and commit are the sidebar's Changes, visible over this (#15), and
 * two copies of a list leave unclear which to click. Whether a file is staged is looked up in status.
 */
function Changes({
  projectId,
  initialPath,
  initialStaged,
  pick,
}: {
  projectId: string
  initialPath?: string | null
  initialStaged?: boolean
  pick: number
}) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const openFile = useStore((s) => s.openFile)
  const remote = useProjectMachine(projectId) !== null
  // A project on a linked machine opens in VS Code over Remote-SSH instead (#82); null where that cannot work
  const remoteIde = useRemoteIde(projectId)
  const [selected, setSelected] = useState<GitFileStatus | null>(null)
  /*
   * An approval rests on this diff: a slow answer must not draw another file's diff under this name. `useLoad` lets only
   * the newest read draw, clears the old diff at once, and says when a read failed rather than draw it empty.
   */
  const diff = useLoad(
    () => (selected ? platform.git.diff(projectId, selected.path, selected.staged) : null),
    [platform, projectId, selected],
  )

  // Follows a sidebar click — once per pick. Clicking again is a retry
  const opened = useRef(-1)
  useEffect(() => {
    if (!initialPath || opened.current === pick) return
    opened.current = pick
    let alive = true
    void platform.git
      .status(projectId)
      .then((files) => {
        if (!alive) return
        /*
         * By path and list together (#160): a partly staged file (MM) is in both Staged and Changed, and the host
         * returns the staged one first, so a click under Changed would open the staged diff.
         */
        const hit = files.find(
          (f) => f.path === initialPath && (initialStaged === undefined || f.staged === initialStaged),
        )
        if (hit) setSelected(hit)
      })
      // Said, as a failed diff is (#850 item 8): silent, the click looks like it did nothing. Clicking again retries
      .catch((e: unknown) => alive && setToast(`Could not load diff: ${errorMessage(e)}`))
    return () => {
      alive = false
    }
  }, [pick, initialPath, initialStaged, platform, projectId, setToast])

  return (
    <div className="flex min-h-0 flex-1">
      <DiffView
        path={selected?.path}
        data={diff.data ?? null}
        failure={diff.error === null ? undefined : { what: 'the diff', error: diff.error, onRetry: () => void diff.reload() }}
        emptyHint="Pick a file from the Changes list on the right"
        // A working-tree diff is the one file clicked into, so only `line` is used, not the diff's `file`
        onOpenInIde={
          remote
            ? remoteIde
              ? async ({ line }) => {
                  if (selected) await remoteIde.open(selected.path, { line })
                }
              : undefined
            : async ({ line }) => {
                if (selected) {
                  try {
                    const { path } = await platform.fs.resolve(projectId, selected.path)
                    await platform.system.openInIde(path, line)
                  } catch (e) {
                    setToast(`Could not open in IDE: ${errorMessage(e)}`)
                  }
                }
              }
        }
        onOpenViewer={selected ? () => openFile(selected.path) : undefined}
        ide={remoteIde ?? undefined}
      />
    </div>
  )
}

/**
 * The diff view, the one place with chromatic colour (an exception to m2-plan decision 1, `--color-diff-add/del`): an
 * approval is made by scanning, which grayscale would slow to reading. The `+`/`-` stay for those who cannot see colour.
 * Copying is rebuilt from the data (issue #36, useVirtualCopy): the rows are virtualized, and the screen's − is a
 * typographic minus no patch tool accepts.
 */
function DiffView({
  path,
  data,
  emptyHint,
  onOpenInIde,
  onOpenViewer,
  ide,
  failure,
}: {
  path?: string
  data: { diff: string; truncated: boolean; binary: boolean } | null
  /** The read of the diff failed (#850 item 8): said where the diff would be, never drawn as an empty diff */
  failure?: { what: string; error: string; onRetry: () => void }
  /** When opened with nothing selected — the list lives in the sidebar, so this has to point there */
  emptyHint?: string
  /**
   * Opens the file and line at the top of the screen. Absent for a linked machine (#82) VS Code's Remote-SSH cannot
   * reach: an IDE on this computer cannot open that machine's file
   */
  onOpenInIde?: (target: { file: string | null; line?: number }) => Promise<void>
  onOpenViewer?: () => void
  /** The button's words when it is not this computer's IDE: VS Code over Remote-SSH, for a linked machine (#82) */
  ide?: { label: string; title: string }
}) {
  const diffText = data?.diff ?? ''
  const rows = useMemo(() => renderableDiffRows(diffText), [diffText])
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const copyLines = useMemo(() => rows.map((r) => ({ text: r.body, prefix: r.marker })), [rows])
  /*
   * Copy and ⌘A over rows not all mounted: the code viewer's rule (useVirtualCopy, #118). Unlike the viewer's, the
   * truncation notice stays off the clipboard: a diff is read by `git apply`, and a broken patch is worse than a partial
   * one (#122).
   */
  const copyProps = useVirtualCopy({
    scrollRef,
    rowsRef,
    lines: copyLines,
    wholeText: diffText,
    resetKey: path ?? null,
    contentKey: diffText,
    ready: !!path && !data?.binary,
  })
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 17,
    overscan: 24,
  })
  const virtualRows = virtualizer.getVirtualItems()
  // The top row decides both the band's file name and where "Open in IDE" goes, once, so the two never drift apart
  const place: DiffPlace = diffPlaceAt(rows, virtualizer.range?.startIndex ?? virtualRows[0]?.index ?? 0)

  if (!path) {
    return (
      <div
        className="flex flex-1 items-center justify-center text-sm text-ink-faint"
        data-testid="diff-empty"
      >
        {emptyHint ?? 'Select a file to see its diff'}
      </div>
    )
  }
  if (data?.binary) {
    return <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">Binary file</div>
  }

  const truncated = Boolean(data?.truncated)

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="diff-view">
      {/* The panel's tab row height (31px, PanelTabs), so this bar's line meets the tabs' line beside it */}
      <header className="flex h-[31px] shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="readout truncate text-xs text-ink-muted">{path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {onOpenViewer && (
            <button
              className="text-xs text-ink-faint hover:text-ink"
              onClick={onOpenViewer}
              data-testid="open-in-viewer"
            >
              Show all
            </button>
          )}
          {onOpenInIde && (
            <button
              className="text-xs text-ink-faint hover:text-ink"
              onClick={() => void onOpenInIde({ file: place.file, line: place.line })}
              data-testid="open-in-ide"
              title={ide?.title}
            >
              {ide?.label ?? 'Open in IDE'}
            </button>
          )}
        </span>
      </header>
      {/*
       * `tabIndex={0}` region, as the viewer's (#139): it scrolls both ways, and at -1 a keyboard could not get in. Named
       * just `Diff`: the header states the file. The line height is written out (1.5 of 11px, estimateSize's ~17px), not
       * `leading-code`, so a theme cannot move the rows from their estimate.
       */}
      <div
        ref={scrollRef}
        role="region"
        aria-label="Diff"
        className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-[1.5]"
        tabIndex={0}
        onMouseDown={() => scrollRef.current?.focus()}
        {...copyProps}
      >
        {place.label && (
          /*
           * Sticky on both axes (`left-0`): otherwise scrolling right carries the band away (#122). `aria-hidden`: it
           * repeats the `diff --git` row visually, which a screen reader would otherwise read twice.
           */
          <div
            className="sticky left-0 top-0 z-20 border-b border-line bg-surface-raised px-3 py-1"
            data-testid="diff-current-file-band"
            aria-hidden="true"
          >
            <span className="readout text-xs text-ink">{place.label}</span>
          </div>
        )}
        {failure && <LoadFailed className="p-3" what={failure.what} error={failure.error} onRetry={failure.onRetry} testId="diff-failed" />}
        <div ref={rowsRef} className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualRows.map((v) => {
            const { kind, body } = rows[v.index]!
            const i = v.index
            /*
             * A file-boundary band: a commit diff is several files in one text. The sticky name is the
             * `diff-current-file-band` above; this row marks the `diff --git` line itself and keeps data-line, so a copy
             * gets the raw text (display ≠ copy, #36).
             */
            if (kind === 'file') {
              const label = diffFileLabel(body)
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  ref={virtualizer.measureElement}
                  data-diff="file"
                  data-line={i}
                  data-testid="diff-file-band"
                  className="absolute left-0 top-0 w-max min-w-full border-b border-line bg-surface-raised px-3 py-1"
                  style={{ transform: `translateY(${v.start}px)` }}
                >
                  <span data-code className="readout text-xs text-ink">
                    {label}
                  </span>
                </div>
              )
            }
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                data-diff={kind}
                data-line={i}
                /*
                 * `w-max`: a `w-full` row is the visible width, so a long line's right half would lose its colour when
                 * scrolled to. `min-w-full` still paints a short line to the edge.
                 */
                className={`absolute left-0 top-0 w-max min-w-full ${
                  kind === 'add'
                    ? 'bg-diff-add-bg text-diff-add'
                    : kind === 'del'
                      ? 'bg-diff-del-bg text-diff-del'
                      : kind === 'hunk'
                        ? 'bg-surface-raised/60 text-ink-muted'
                        : 'text-ink-muted'
                }`}
                style={{ transform: `translateY(${v.start}px)` }}
              >
                <span className="inline-block w-4 select-none text-center opacity-70">
                  {kind === 'add' ? '+' : kind === 'del' ? '−' : ''}
                </span>
                {/* Indentation is information: under `white-space: normal` a 9-space and an 8-space indent
                    draw the same (#122). The viewer is whitespace-pre too. */}
                <span data-code className="whitespace-pre">
                  {body}
                </span>
              </div>
            )
          })}
        </div>
        {truncated && (
          <p className="p-2 text-xs text-ink-faint" data-testid="diff-truncation">
            {DIFF_TRUNCATED_MESSAGE}
          </p>
        )}
      </div>
    </div>
  )
}

/** B-3 commit detail: a commit picked in the sidebar's History opens its diff here, full width; the list stays there */
function History({
  projectId,
  initialSha,
  pick,
}: {
  projectId: string
  initialSha?: string | null
  pick: number
}) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const remote = useProjectMachine(projectId) !== null
  const remoteIde = useRemoteIde(projectId)
  /*
   * The newest click wins, as on Changes: A's slower answer must not draw while B is picked, and a failed commit must not
   * leave the one before on screen. Each click is a new request (`pick`), so the same commit clicked again is read again.
   */
  const request = useMemo(() => ({ sha: initialSha, pick }), [initialSha, pick])
  const detail = useLoad(
    () => (request.sha ? platform.git.commitDetail(projectId, request.sha) : null),
    [platform, projectId, request],
  )

  return (
    <div className="flex min-h-0 flex-1">
      <DiffView
        path={detail.data ? `${detail.data.files.length} files` : initialSha ? initialSha.slice(0, 7) : undefined}
        data={detail.data ? { diff: detail.data.diff, truncated: detail.data.truncated, binary: false } : null}
        failure={detail.error === null ? undefined : { what: 'the commit', error: detail.error, onRetry: () => void detail.reload() }}
        emptyHint="Pick a commit from the History list on the right"
        /*
         * Opens a real file, never a dead `async () => {}` (#122): the band's file, in the working tree, as an IDE cannot
         * open a sha's blob. The line is the commit's new side; it can drift after edits, but lands nearer than line 1.
         */
        onOpenInIde={
          remote
            ? remoteIde
              ? async ({ file, line }) => {
                  if (!file) return setToast('Could not tell which file this line belongs to')
                  await remoteIde.open(file, { line })
                }
              : undefined
            : async ({ file, line }) => {
                if (!file) {
                  setToast('Could not tell which file this line belongs to')
                  return
                }
                try {
                  const { path } = await platform.fs.resolve(projectId, file)
                  await platform.system.openInIde(path, line)
                } catch (e) {
                  setToast(`Could not open in IDE: ${errorMessage(e)}`)
                }
              }
        }
        ide={remoteIde ?? undefined}
      />
    </div>
  )
}

/** B-4 branches tab — does not block a dirty working tree; shows what is at stake first */
function Branches({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  // The one write here moves the branch **name** the sidebar prints, so it goes through the
  // store too (issue #49) — the dry run beside it changes nothing and stays a plain read.
  const gitCheckout = useStore((s) => s.gitCheckout)
  /*
   * A failed read is not an empty list (#850 item 8): no branch at all would read as a repository with none.
   * A refresh after a checkout that fails keeps the list beside the error
   */
  const loaded = useLoad<GitBranch[]>(() => platform.git.branches(projectId), [platform, projectId])
  const branches = loaded.data ?? null
  const load = () => void loaded.reload()
  const [pending, setPending] = useState<{ branch: string; conflicts: string[] } | null>(null)

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

  // The split is decided by `remote`, which the host derives from the full reference name
  // (#175). Re-parsing the short name could not tell `origin/main` and `feature/login` apart —
  // both have a `/` in the short name.
  const local = (branches ?? []).filter((b) => !b.remote)
  const remote = (branches ?? []).filter((b) => b.remote)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="git-branches">
      {pending && (
        <div className="border-b border-line bg-surface-raised p-3" data-testid="checkout-warning">
          <p className="text-sm text-ink">Switching to {pending.branch} may affect the changes below.</p>
          <ul className="readout mt-1.5 max-h-24 overflow-y-auto text-xs text-ink-muted">
            {pending.conflicts.slice(0, 10).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div className="mt-2 flex gap-1.5">
            <Button variant="primary" size="md" onClick={() => void doCheckout(pending.branch)} data-testid="checkout-proceed">
              Switch anyway
            </Button>
            <Button variant="ghost" size="md" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {loaded.error !== null && (
        <LoadFailed what="the branches" error={loaded.error} onRetry={load} className="border-b border-line px-2.5 py-1.5" testId="git-branches-failed" />
      )}
      <BranchList title="Local" branches={local} onPick={attempt} />
      <BranchList title="Remote" branches={remote} onPick={attempt} />
    </div>
  )
}

function BranchList({
  title,
  branches,
  onPick,
}: {
  title: string
  branches: GitBranch[]
  onPick: (b: string) => void
}) {
  if (branches.length === 0) return null
  return (
    <div className="border-b border-line" data-testid={`branches-${title.toLowerCase()}`}>
      <Badge as="h3" className="px-2.5 py-1.5">
        {title}
      </Badge>
      <ul>
        {branches.map((b) => (
          <li key={b.name}>
            <button
              className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-sm transition-colors ${
                b.current ? 'text-ink' : 'text-ink-muted hover:text-ink'
              }`}
              onClick={() => !b.current && onPick(b.name)}
              data-testid={`branch-${b.name}`}
            >
              <span className="w-2.5 shrink-0 text-center text-2xs text-ink-faint">
                {b.current ? '●' : ''}
              </span>
              <span className="truncate">{b.name}</span>
              {b.upstream && (
                <span className="readout ml-auto shrink-0 text-2xs text-ink-faint">→ {b.upstream}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
