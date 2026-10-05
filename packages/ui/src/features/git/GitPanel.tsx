import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { GitBranch, GitFileStatus } from '@cc/protocol'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { useProjectMachine } from '../../store/selectors.js'
import { caretAt, selectedText, type Caret } from '../viewer/copy.js'
import { diffFileLabel, diffPlaceAt, renderableDiffRows, type DiffPlace } from './diff.js'

type SubTab = 'changes' | 'history' | 'branches'

const DIFF_TRUNCATED_MESSAGE = '…diff is too large; showing part of it. Open in your IDE to see the rest.'

/**
 * Git panel (FR-4, B-2 through B-6).
 * Builds the basis for an approval decision inside the app itself — so nobody has to leave for
 * the IDE just to see this.
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
   * There is no tab strip (user request, 2026-09-07). The Changes, History and Branches entry
   * points already all live in the evidence sidebar on the right (visible even during an
   * overlay, via #15) — having them here too would give the same three doors two copies each.
   * This screen shows **only whichever one was clicked into** — which screen it is derives from
   * the click (initialSub), not from state.
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
 * B-2 change diff — **the list, staging and commit belong to the sidebar on the right** (left
 * column removed 2026-09-07).
 *
 * A file list used to sit here too, but the sidebar's Changes already holds the same list and
 * it stays visible even during an overlay (#15) — two copies of the same list left it unclear
 * which one to click (user's observation). This screen draws the one thing that needs room, the
 * diff, and nothing else. Whether a file is staged is still needed without the list, so it is
 * looked up by finding that file in status.
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
  const [selected, setSelected] = useState<GitFileStatus | null>(null)
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean; binary: boolean } | null>(null)

  /*
   * A request generation number. This diff is **the basis for an approval decision** — clicking
   * through files in quick succession can let a slow response arrive late and draw **a
   * different file's diff** under the name of the file currently on screen. Only the most
   * recent request is allowed to write to the screen.
   */
  const diffGen = useRef(0)
  const openDiff = useCallback(
    async (f: GitFileStatus) => {
      const gen = ++diffGen.current
      setSelected(f)
      setDiff(null) // Does not leave an old file's diff sitting under the new file's name
      try {
        const d = await platform.git.diff(projectId, f.path, f.staged)
        if (gen === diffGen.current) setDiff(d)
      } catch (e) {
        if (gen === diffGen.current) setToast(`Could not load diff: ${(e as Error).message}`)
      }
    },
    [platform, projectId, setToast],
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
         * Picking by path alone is not safe (#160). A partially staged file (MM) shows up in
         * both Staged and Changed, and the host returns the staged one first — clicking it
         * under Changed still opened the staged diff under the same file name. This matches
         * both the path and which list it was clicked from together.
         */
        const hit = files.find(
          (f) => f.path === initialPath && (initialStaged === undefined || f.staged === initialStaged),
        )
        if (hit) void openDiff(hit)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [pick, initialPath, initialStaged, platform, projectId, openDiff])

  return (
    <div className="flex min-h-0 flex-1">
      <DiffView
        path={selected?.path}
        data={diff}
        emptyHint="Pick a file from the Changes list on the right"
        /*
         * The working-tree diff is a single file — which file it is comes from the file that
         * was clicked into, not from a `diff --git` inside the diff itself. That is why only
         * `line` is used and `file` is not.
         */
        onOpenInIde={remote ? undefined : async ({ line }) => {
          if (selected) {
            try {
              const { path } = await platform.fs.resolve(projectId, selected.path)
              await platform.system.openInIde(path, line)
            } catch (e) {
              setToast(`Could not open in IDE: ${(e as Error).message}`)
            }
          }
        }}
        onOpenViewer={selected ? () => openFile(selected.path) : undefined}
      />
    </div>
  )
}

/**
 * The diff view.
 *
 * This is the one place chromatic color is used (an exception to m2-plan decision 1 — see
 * --color-diff-add/del in styles/index.css). Green for additions, red for deletions. `+`/`-` plus
 * brightness would still distinguish them in grayscale, but an approval decision is made by
 * scanning, and forcing it to be read line by line would break that flow. The symbols stay
 * anyway — for someone who cannot see color, leaving only the color behind would erase the
 * information.
 *
 * Copying needs the viewer's handler (issue #36), for the opposite reason to the viewer's.
 * The rows are virtualized for large diffs, so the clipboard must be rebuilt from the full
 * backing data instead of the mounted DOM. Markers are also drawn in their own `select-none`
 * span, and the screen's − is a typographic minus that no patch tool accepts. The payload is
 * therefore rebuilt from the data, marker included, so copied diffs stay complete and valid.
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
  /** When opened with nothing selected — the list lives in the sidebar, so this has to point there */
  emptyHint?: string
  /**
   * Where the top of the screen currently points — which file, and which line of it, to open. Absent for a project on
   * a linked machine (#82): an IDE on this computer cannot open that machine's file
   */
  onOpenInIde?: (target: { file: string | null; line?: number }) => Promise<void>
  onOpenViewer?: () => void
}) {
  const diffText = data?.diff ?? ''
  const rows = useMemo(() => renderableDiffRows(diffText), [diffText])
  const scrollRef = useRef<HTMLDivElement>(null)
  const wholeDiff = useRef(false)
  const anchor = useRef<Caret | null>(null)
  const copyLines = useMemo(() => rows.map((r) => ({ text: r.body, prefix: r.marker })), [rows])

  // Match the code viewer's selection contract: recycled DOM rows must not shorten copy.
  useEffect(() => {
    wholeDiff.current = false
    anchor.current = null
  }, [path, diffText])

  /*
   * ⌘A has to land somewhere.
   *
   * This panel is not a text field, so it never took focus on its own, and picking a file
   * **from the evidence sidebar** left focus sitting on that button. From there, ⌘A went to the
   * document, copy happened without wholeDiff ever being set, and the onCopy handler below
   * captured only the mounted rows, hijacking the browser's otherwise-correct copy — 60 lines
   * out of 37,236 (#118). The viewer (CodeViewer) does the same thing for the same reason.
   *
   * **Only once per path.** Grabbing it every time would steal focus back while someone is
   * typing into a search box.
   */
  const focusedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!path || data?.binary || focusedFor.current === path) return
    focusedFor.current = path
    scrollRef.current?.focus()
  }, [path, data?.binary])
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = document.getSelection()
      const root = scrollRef.current
      if (!sel?.anchorNode || !root?.contains(sel.anchorNode)) return
      const caret = caretAt(sel.anchorNode, sel.anchorOffset)
      if (caret || sel.isCollapsed) anchor.current = caret
    }
    const onMouseDown = () => { wholeDiff.current = false }
    const onCopy = (event: ClipboardEvent) => {
      const root = scrollRef.current
      if (!root || !path || data?.binary) return
      const selection = document.getSelection()
      /*
       * **It does not block what it cannot count.**
       *
       * This listener is attached to document, so it fires for every copy inside the window. If
       * the selection starts or ends outside this panel, all this code can construct is this
       * panel's own share of it, and blocking the default behavior with just that would
       * silently drop the rest. It is more honest to let the browser do what it would have done
       * anyway.
       */
      const spansOutside =
        !!selection &&
        (!selection.anchorNode ||
          !selection.focusNode ||
          !root.contains(selection.anchorNode) ||
          !root.contains(selection.focusNode))
      if (!wholeDiff.current && spansOutside) return
      /*
       * The fact that the diff was truncated is stated by the on-screen notice
       * (`diff-truncation`) — **it is not put into the clipboard.** The viewer (CodeViewer) does
       * put it there: a file's body is read by a person, and one extra line does not get in the
       * way of that. A diff is read by `git apply`. Handing that parser a sentence written for a
       * person breaks it on the spot — worse than a partial patch is a broken one (#122).
       */
      const payload = wholeDiff.current
        ? diffText
        : selectedText({ selection, root, lines: copyLines, lastAnchor: anchor.current })
      if (payload === null) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', payload)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('copy', onCopy)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('copy', onCopy)
    }
  }, [path, diffText, copyLines, data?.binary, data?.truncated])
  const paintSelection = () => {
    const root = scrollRef.current
    const selection = document.getSelection()
    if (!root || !selection) return
    const range = document.createRange()
    range.selectNodeContents(root)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 17,
    overscan: 24,
  })
  const virtualRows = virtualizer.getVirtualItems()
  /*
   * One thing — the row currently at the top of view — decides two things: the file name shown
   * in the band, and where "Open in IDE" takes the person. The same computation is not done
   * twice — doing it twice would let the file the band names and the file the IDE opens drift
   * apart, which is exactly the kind of lie this panel exists to remove.
   */
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

  /**
   * Each line split the way it is drawn: the marker moves into its own span, `body` is what
   * is left. Splitting it once here is what lets the copy handler below put the line back
   * together — and it stops `--- a/foo` from losing a dash, which the old blanket
   * `replace(/^[+-]/, '')` did to every file header, since the classifier calls those
   * context lines.
   */
  const truncated = Boolean(data?.truncated)

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="diff-view">
      <header className="flex items-center gap-2 border-b border-line px-3 py-1.5">
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
            >
              Open in IDE
            </button>
          )}
        </span>
      </header>
      {/*
       * `tabIndex={0}` is correct here — the viewer (CodeViewer) is 0 for the same reason
       * (#139). This panel **scrolls both horizontally and vertically**. At -1, someone not
       * using a mouse has no way in, and would never see the far right end of a wrapped-tight
       * line. It is instead named as a region so Tab does not land on an unnamed `<div>`. There
       * is also a reason to keep the name as just `Diff`: the file name is already stated by
       * the header right above, and stating it again here would read the same name twice (the
       * same problem as the band below).
       *
       * The line height stays written out (1.5 of 11px, the ~17px rows the virtual list
       * estimates) instead of using `leading-code`: a theme changing the code line height must
       * not move the rows away from their estimate.
       */}
      <div
        ref={scrollRef}
        role="region"
        aria-label="Diff"
        className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-[1.5]"
        tabIndex={0}
        onMouseDown={() => scrollRef.current?.focus()}
        onKeyDown={(event) => {
          if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'a') return
          event.preventDefault()
          wholeDiff.current = true
          paintSelection()
        }}
        onScroll={() => { if (wholeDiff.current) paintSelection() }}
      >
        {place.label && (
          /*
           * Without `left-0`, this only sticks vertically: scrolling 1,500px to the right
           * would carry the band along by -1,500px too (found again, #122) — the moment
           * someone scrolls right to see the end of a long line, the very band that was
           * telling them which file disappears. Sticky has to be set on both axes.
           *
           * `aria-hidden`: this is a device to follow the `diff --git` row in the list
           * **visually**. On screen it sits overlapping that row and reads as one thing, but
           * without hiding it, a screen reader would read the same file name twice. The real
           * content is that row in the list.
           */
          <div
            className="sticky left-0 top-0 z-20 border-b border-line bg-surface-raised px-3 py-1"
            data-testid="diff-current-file-band"
            aria-hidden="true"
          >
            <span className="readout text-xs text-ink">{place.label}</span>
          </div>
        )}
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualRows.map((v) => {
            const { kind, body } = rows[v.index]!
            const i = v.index
            /*
             * A file-boundary band (user's choice, 2026-09-07 — a commit diff is several files
             * as one block of text, and there was no way to see where the next file started).
             * In a virtualized scroll, the actual sticky display is handled by
             * `diff-current-file-band` above; this row shows the raw `diff --git` position
             * itself. data-line stays as is, so copying still produces the raw text (display ≠
             * copy, from #36).
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
                 * With `w-full`, a row's width is **the visible width**, so scrolling right
                 * leaves the green or red background behind on the left and the right half goes
                 * colorless — color is exactly the device that lets an approval decision be
                 * scanned, and it is missing on precisely the long lines. `w-max` widens it to
                 * fit the content, and `min-w-full` still paints a short line all the way to
                 * the edge.
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
                {/* Indentation is information in a diff — the default `white-space: normal` drew a 9-space
                    indent and an 8-space indent in the same spot (#122). The viewer (CodeViewer) uses
                    whitespace-pre for the same reason. */}
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

/**
 * B-3 commit detail — **the list belongs to the sidebar's History** (left column removed
 * 2026-09-07). Clicking a commit in the sidebar opens its diff here, laid out full width.
 * Picking the next commit happens in the sidebar too — two copies of the same list would be
 * confusing (the same judgment as with Changes).
 */
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
  const [detail, setDetail] = useState<{
    sha: string
    files: string[]
    diff: string
    truncated: boolean
  } | null>(null)

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
        /*
         * An `async () => {}` used to sit here, so clicking the button on the commit screen did
         * nothing — a dead button is worse than no button at all (#122).
         *
         * A commit diff spans several files, so "which file" has to be told by the diff itself:
         * it is whichever file the band is pointing at. What gets opened is **that file in the
         * working tree** — an IDE cannot open a specific sha's blob. The line number is also
         * based on the commit's new side, so it can drift if there have been edits since, but
         * it lands closer than dropping the person on line 1.
         */
        onOpenInIde={remote ? undefined : async ({ file, line }) => {
          if (!file) {
            setToast('Could not tell which file this line belongs to')
            return
          }
          try {
            const { path } = await platform.fs.resolve(projectId, file)
            await platform.system.openInIde(path, line)
          } catch (e) {
            setToast(`Could not open in IDE: ${(e as Error).message}`)
          }
        }}
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
  const [branches, setBranches] = useState<GitBranch[] | null>(null)
  const [pending, setPending] = useState<{ branch: string; conflicts: string[] } | null>(null)

  const load = useCallback(() => {
    void platform.git
      .branches(projectId)
      .then(setBranches)
      .catch(() => setBranches([]))
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

  // The split is decided by `remote`, which the host derives from the full reference name
  // (#175). Re-parsing the short name could not tell `origin/main` and `feature/login` apart —
  // both have a `/` in the short name.
  const local = (branches ?? []).filter((b) => !b.remote)
  const remote = (branches ?? []).filter((b) => b.remote)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="git-branches">
      {pending && (
        <div className="border-b border-line bg-surface-raised p-3" data-testid="checkout-warning">
          <p className="text-sm text-ink">
            Switching to {pending.branch} may affect the changes below.
          </p>
          <ul className="readout mt-1.5 max-h-24 overflow-y-auto text-xs text-ink-muted">
            {pending.conflicts.slice(0, 10).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div className="mt-2 flex gap-1.5">
            <button
              className="rounded-md border border-line bg-surface-raised px-2 py-1 text-sm text-ink hover:border-line-strong"
              onClick={() => void doCheckout(pending.branch)}
              data-testid="checkout-proceed"
            >
              Switch anyway
            </button>
            <button
              className="rounded-md px-2 py-1 text-sm text-ink-faint hover:text-ink"
              onClick={() => setPending(null)}
            >
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
    <div className="border-b border-line/60" data-testid={`branches-${title.toLowerCase()}`}>
      <h3 className="px-2.5 py-1.5 text-2xs uppercase text-ink-faint">{title}</h3>
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
              <span className="w-2.5 shrink-0 text-center text-2xs text-ink-faint">{b.current ? '●' : ''}</span>
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
