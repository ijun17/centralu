import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import type { FsFile } from '@cc/platform/ports'
import { useStore } from '../../store/store.js'
import { useShortcut } from '../../app/shortcut.js'
import { Kbd } from '../../components/primitives.jsx'
import { TRUNCATED_NOTICE, caretAt, selectedText, wholeFileText, type Caret } from './copy.js'
import { clearViewerJump, currentViewerJump, requestViewerJump, useViewerJump } from './jump.js'
import { suffixMatches } from './resolve.js'

/**
 * Code viewer (FR-6, C-3) — **read-only**. Editing belongs to the IDE (a non-goal).
 *
 * Not bringing in anything heavy is the design of this screen:
 *   - No CodeMirror or Shiki. An editor engine is overkill for a read-only display, and Shiki's
 *     default engine is WASM, which conflicts with Tauri's CSP (no `wasm-unsafe-eval`).
 *   - Virtual scrolling plus grayscale emphasis (only comments and strings set apart by
 *     brightness) reads well enough instead.
 *   - If precise highlighting is needed, "Open in IDE" is one click away.
 */
export function CodeViewer({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const path = useStore((s) => s.viewerPath)
  const setToast = useStore((s) => s.setToast)
  // Hooks come before the `if (!path)` early return below — placed after it, the hook count would differ per render
  const sc = useShortcut()
  const jump = useViewerJump()
  const [file, setFile] = useState<FsFile | null>(null)
  /**
   * Why the failure gets a place on screen and not only a toast.
   *
   * A file can now be opened by clicking a path an agent typed, and that path is a guess —
   * nothing checked it against the disk before it became a link (see `parseFileRef`). So a
   * file that is not there is an ordinary outcome here, not an exotic one. The toast alone
   * could not carry it: it is a 2.5s pill and this overlay covers the lane it appears in,
   * so the one thing left on screen would be "Loading…", forever, about a file that will
   * never load.
   */
  const [error, setError] = useState<string | null>(null)
  /**
   * Candidates for when several files end with the same name (resolve.ts).
   *
   * If there is one, it opens there with no fuss. If there are several, the person is asked to
   * pick — picking one of them for them would be a guess dressed up as a fact, and this screen
   * does not make a guess look like a fact.
   */
  const [candidates, setCandidates] = useState<string[]>([])
  /** A place already opened once — so if even that file cannot be read, the same place is not reopened forever */
  const resolved = useRef(new Set<string>())
  /** The row a `path:123` click asked for — highlighted, because landing mid-file is disorienting */
  const [landedIndex, setLandedIndex] = useState(-1)
  const [query, setQuery] = useState('')
  /** An SVG is both source and a picture, so the person picks which one to look at. */
  const [svgPreview, setSvgPreview] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  /** ⌘A was pressed and no new selection has started since — copy owes the whole file */
  const wholeFile = useRef(false)
  /** The last readable anchor of the current selection (see `selectedText`) */
  const anchor = useRef<Caret | null>(null)
  const focusedFor = useRef<string | null>(null)
  /**
   * The width of the widest row drawn so far in this file (#139).
   *
   * A row is absolutely positioned, so it cannot push its parent's width wider. That means a row
   * with `w-full` only paints as wide as **the visible width**, so scrolling right drags the
   * search or landed row's background back to the left, and the line number (`sticky left-0`)
   * cannot follow past its own row either and disappears with it. GitPanel's `w-max min-w-full`
   * only rescues the long lines — a short line is still just the visible width (found again:
   * scroll 1,500px and a short line's right edge sits at -1,500). The container holding the rows
   * has to be widened to the widest row for every row to paint all the way to the edge.
   *
   * Because this is a virtual list, only the rows that are drawn can be measured, and the value
   * never shrinks: when a long line scrolls off screen, the horizontal scroll width stays put,
   * so the spot being looked at does not jump to the left.
   */
  const [rowsWidth, setRowsWidth] = useState(0)

  useEffect(() => {
    setFile(null)
    setRowsWidth(0)
    setError(null)
    setCandidates([])
    setLandedIndex(-1)
    setSvgPreview(true)
    if (!path) return
    // While switching files or projects, a late response must never be drawn as **another file's content**
    let alive = true
    void platform.fs
      .readFile(projectId, path)
      .then((f) => alive && setFile(f))
      .catch((e: Error) => {
        if (!alive) return
        /*
         * Not being at the root does not make it a dead link. An agent often writes a path
         * relative to wherever it happened to be looking (`Media/ImageSearch.cs` ↔ the real one
         * being `WzComparerR2.Cli/Media/…`). This looks through the project's file list for one
         * with that tail — only after the first attempt failed, and since the host holds the
         * index, this one extra call is cheap.
         */
        void platform.fs
          .search(projectId, path, 20)
          .catch(() => [] as { path: string; name: string }[])
          .then((hits) => {
            if (!alive) return
            const found = suffixMatches(
              hits.map((h) => h.path),
              path,
            ).filter((p) => !resolved.current.has(p))
            if (found.length === 1) {
              const target = found[0]!
              resolved.current.add(target)
              // The line number was requested under the old path, so it has to be requested again under the new one to survive
              const jumpNow = currentViewerJump()
              if (jumpNow?.path === path) requestViewerJump(target, jumpNow.line)
              useStore.getState().openFile(target)
              return
            }
            setCandidates(found.slice(0, 8))
            setError(e.message)
            // No reason to stack a toast on top when the screen is already asking the person to pick a candidate
            if (found.length === 0) setToast(e.message)
          })
      })
    return () => {
      alive = false
    }
  }, [platform, projectId, path, setToast])

  const image = file?.image && isViewerImage(file.image) ? file.image : null
  const isSvg = image?.mime === 'image/svg+xml'
  const showingImage = !!image && (!isSvg || svgPreview)
  const lines = useMemo(() => (file?.text ?? '').split('\n'), [file])
  const matches = useMemo(() => {
    if (!query.trim()) return new Set<number>()
    const q = query.toLowerCase()
    const hit = new Set<number>()
    lines.forEach((l, i) => l.toLowerCase().includes(q) && hit.add(i))
    return hit
  }, [lines, query])
  /*
   * Moves between search results (#183). While only the highlighting and a count existed, since
   * the list is virtualized, a match off screen had to be found by scrolling by hand. Enter goes
   * to the next one, ⇧Enter to the previous — wrapping around at either end. Which match it is
   * on resets to the start whenever the search term or the file changes.
   */
  const matchLines = useMemo(() => [...matches], [matches])
  const [matchAt, setMatchAt] = useState(-1)
  useEffect(() => setMatchAt(-1), [matchLines])

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 30,
  })

  /**
   * Land on the line a `path:123` click named (#39).
   *
   * Cheap precisely because the list is virtual: the row is not on screen and does not
   * have to be — `scrollToIndex` works off the row index, so a line 4000 files deep costs
   * the same as line 4. It waits for `file` because until the text is split there are no
   * rows to count, and it clamps because an agent's line number can outrun the file it
   * names (stale reading, truncated file) and a jump past the end should land at the end
   * rather than nowhere.
   */
  const stepMatch = (dir: 1 | -1) => {
    const n = matchLines.length
    if (n === 0) return
    const next = matchAt < 0 ? (dir === 1 ? 0 : n - 1) : (matchAt + dir + n) % n
    setMatchAt(next)
    virtualizer.scrollToIndex(matchLines[next]!, { align: 'center' })
  }

  useEffect(() => {
    if (!file || !jump || jump.path !== path) return
    clearViewerJump()
    const index = Math.min(jump.line, lines.length) - 1
    setLandedIndex(index)
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [file, jump, path, lines.length, virtualizer])

  // Returns the same array if the virtual list's range is unchanged — remeasures only when the drawn rows change
  const virtualItems = virtualizer.getVirtualItems()
  // Measured before painting — so a short row is never seen, even for one frame, painted only as wide as the visible width
  useLayoutEffect(() => {
    const el = rowsRef.current
    if (!el) return
    let widest = 0
    for (const row of Array.from(el.children)) {
      // The row itself is the width of the container, so its content's (line number + code) width is summed instead
      let w = 0
      for (const cell of Array.from(row.children)) w += cell.getBoundingClientRect().width
      widest = Math.max(widest, Math.ceil(w))
    }
    if (widest > rowsWidth) setRowsWidth(widest)
  }, [virtualItems, file, showingImage, rowsWidth])

  /**
   * Remember where the selection began, while the row it began on still exists.
   *
   * This is the whole of the virtualization problem in one place. The focus end of a
   * selection sits under the pointer, so it is always mounted. The anchor end is not: drag
   * from line 3 downwards and, the moment the list scrolls far enough for row 3 to be
   * recycled, the browser has to put the anchor *somewhere* — and it walks it outward, out
   * of the rows and up into the app chrome. That is where the reported garbage came from:
   * the selection ends up spanning "Files / esc back to chat / Open in IDE" and ⌘C copies
   * exactly that. Reading the anchor here, while it is still a row, is what lets the copy
   * handler serve lines 3…N instead.
   *
   * A collapsed selection is a *new* one beginning, so it overwrites the memory even with
   * null; otherwise a stale anchor would leak into the next copy. An anchor that has been
   * walked out of `root` is not an answer to anything, so it is ignored rather than stored.
   */
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = document.getSelection()
      const root = scrollRef.current
      if (!sel || !root || !sel.anchorNode || !root.contains(sel.anchorNode)) return
      const caret = caretAt(sel.anchorNode, sel.anchorOffset)
      if (caret || sel.isCollapsed) anchor.current = caret
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  /**
   * ⌘C. Scoped by *what is selected*, not by where the event lands.
   *
   * The obvious place for this is an `onCopy` on the code area, and it is the wrong place:
   * once the browser has walked the selection out into the app chrome (above), the copy
   * event no longer passes through the code area at all, and the one case that has to be
   * caught is the one that escapes. So the listener is on the document and asks a narrower
   * question instead — does this selection touch any of our rows? If not, it is somebody
   * else's copy and is left alone.
   */
  useEffect(() => {
    if (!file || showingImage) return
    const onCopy = (e: ClipboardEvent) => {
      const root = scrollRef.current
      if (!root) return
      const payload = wholeFile.current
        ? wholeFileText(file.text, file.truncated)
        : selectedText({
            selection: document.getSelection(),
            root,
            lines: lines.map((text) => ({ text })),
            lastAnchor: anchor.current,
          })
      if (payload === null) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', payload)
    }
    // Any click starts a new selection, so ⌘A's claim on the clipboard ends there
    const onMouseDown = () => {
      wholeFile.current = false
    }
    document.addEventListener('copy', onCopy)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('mousedown', onMouseDown)
    }
  }, [file, showingImage, lines])

  /**
   * ⌘A has to land somewhere. The code area is not a text field, so it takes focus once the
   * file is on screen — otherwise the key would reach the window and mean nothing here.
   * Once per opened path, so it never steals the search box back mid-typing.
   */
  useEffect(() => {
    if (!file || showingImage || focusedFor.current === path) return
    focusedFor.current = path
    wholeFile.current = false
    scrollRef.current?.focus()
  }, [file, path, showingImage])

  /**
   * Paint the selection over every row that exists right now.
   *
   * With ⌘A the highlight can only ever cover the mounted rows — the rest is not there to
   * light up. Repainting as the file scrolls keeps the highlight under the eye, and keeps a
   * live selection alive at all: without one the browser fires no `copy` event and ⌘C would
   * do nothing. What lands on the clipboard is `file.text` either way.
   */
  const paintMountedRows = () => {
    const el = rowsRef.current
    const sel = document.getSelection()
    if (!el || !sel) return
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  if (!path) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2" data-testid="viewer-empty">
        <p className="text-[13px] text-ash">Select a file</p>
        <p className="text-[11px] text-slate">
          <Kbd>{sc('mod', '⇧2')}</Kbd> pick a file in the tree to open it here
        </p>
      </div>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="code-viewer">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <span className="readout truncate text-[11px] text-ash" data-testid="viewer-path">
          {path}
        </span>
        {!showingImage && (
          <>
            <input
              className="ml-2 w-40 rounded border border-edge bg-panel px-2 py-0.5 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
              placeholder="Search in file"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                e.preventDefault()
                stepMatch(e.shiftKey ? -1 : 1)
              }}
              data-testid="viewer-search"
            />
            {query && (
              <span className="readout text-[10px] text-slate" data-testid="viewer-match-count">
                {matchAt >= 0 ? `${matchAt + 1}/${matchLines.length}` : `${matches.size} lines`}
              </span>
            )}
          </>
        )}
        {isSvg && (
          <span className="ml-2 flex overflow-hidden rounded border border-edge text-[10px]" data-testid="viewer-svg-mode">
            <button
              type="button"
              className={`px-2 py-0.5 transition-colors ${
                !svgPreview ? 'bg-graphite text-chalk' : 'text-slate hover:text-chalk'
              }`}
              onClick={() => setSvgPreview(false)}
              data-testid="viewer-svg-text"
            >
              Text
            </button>
            <button
              type="button"
              className={`border-l border-edge px-2 py-0.5 transition-colors ${
                svgPreview ? 'bg-graphite text-chalk' : 'text-slate hover:text-chalk'
              }`}
              onClick={() => setSvgPreview(true)}
              data-testid="viewer-svg-preview"
            >
              Preview
            </button>
          </span>
        )}
        <button
          className="ml-auto shrink-0 text-[11px] text-slate hover:text-chalk"
          onClick={() => {
            void platform.fs
              .resolve(projectId, path)
              .then(({ path: abs }) => platform.system.openInIde(abs))
              .catch((e) => setToast(`Could not open in IDE: ${(e as Error).message}`))
          }}
          data-testid="viewer-open-ide"
        >
          Open in IDE
        </button>
      </header>

      {error !== null ? (
        <div className="p-3">
          <p className="text-[12px] text-ash" data-testid="viewer-error">
            Could not open this file — {error}
          </p>
          {candidates.length > 0 && (
            <div className="mt-2" data-testid="viewer-candidates">
              <p className="text-[11px] text-slate">
                Files ending in <span className="readout text-ash">{path}</span> — did you mean:
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {candidates.map((c) => (
                  <li key={c}>
                    <button
                      type="button"
                      data-testid={`viewer-candidate-${c}`}
                      onClick={() => {
                        const jumpNow = currentViewerJump()
                        if (jumpNow?.path === path) requestViewerJump(c, jumpNow.line)
                        useStore.getState().openFile(c)
                      }}
                      className="readout rounded px-1 py-0.5 text-left text-[11px] text-chalk underline decoration-slate underline-offset-2 hover:decoration-chalk"
                    >
                      {c}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : file === null ? (
        <p className="p-3 text-[12px] text-slate">Loading…</p>
      ) : showingImage && image ? (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto bg-void p-4"
          data-testid="viewer-image"
        >
          <img
            src={`data:${image.mime};base64,${image.data}`}
            alt={`Preview of ${path}`}
            className="max-h-full max-w-full object-contain"
            data-testid="viewer-image-content"
          />
          <p className="readout shrink-0 text-[10px] text-slate">{(file.bytes / 1024).toFixed(0)}KB</p>
        </div>
      ) : file.binary ? (
        <p className="p-3 text-[12px] text-slate" data-testid="viewer-binary">
          {file.previewError ?? `Binary file (${(file.bytes / 1024).toFixed(0)}KB)`}
        </p>
      ) : (
        /*
         * `tabIndex={0}` + region — the same judgment as GitPanel's diff panel (#139). This
         * panel also **scrolls horizontally** (tested with a single 4,000-character line). It
         * does take focus once when the file opens, but at -1, once that focus is lost there is
         * no way back in by keyboard, and the far right end of a wrapped-tight line would never
         * be seen. The name is left as just `Code` — the path is already stated by the header
         * right above.
         */
        <div
          ref={scrollRef}
          role="region"
          aria-label="Code"
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[18px] focus:outline-none"
          onKeyDown={(e) => {
            // Both modifiers, like every other shortcut here. ⌘⇧A is the global "next
            // waiting session" and must fall through untouched.
            if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'a') return
            e.preventDefault()
            wholeFile.current = true
            paintMountedRows()
          }}
          onScroll={() => {
            if (wholeFile.current) paintMountedRows()
          }}
        >
          <div
            ref={rowsRef}
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px`, minWidth: `${rowsWidth}px` }}
          >
            {virtualItems.map((v) => (
              <div
                key={v.key}
                data-line={v.index}
                data-landed={v.index === landedIndex || undefined}
                data-current-match={(matchAt >= 0 && v.index === matchLines[matchAt]) || undefined}
                className={`absolute left-0 flex w-full ${
                  matchAt >= 0 && v.index === matchLines[matchAt]
                    ? 'bg-graphite'
                    : matches.has(v.index) || v.index === landedIndex
                      ? 'bg-graphite/50'
                      : ''
                }`}
                style={{ top: `${v.start}px`, height: `${v.size}px` }}
              >
                <span className="sticky left-0 w-12 shrink-0 select-none bg-void pr-2 text-right text-slate">
                  {v.index + 1}
                </span>
                <span data-code className="whitespace-pre text-ash">{lines[v.index]}</span>
              </div>
            ))}
          </div>
          {file.truncated && <p className="p-2 text-[11px] text-slate">{TRUNCATED_NOTICE}</p>}
        </div>
      )}
    </section>
  )
}

/** The host is the primary gate; this keeps a malformed adapter response from becoming a data URL. */
function isViewerImage(image: NonNullable<FsFile['image']>): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'].includes(image.mime)
}
