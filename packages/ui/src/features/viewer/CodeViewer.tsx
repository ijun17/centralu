import { errorMessage } from '@cc/protocol/client'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import type { FsFile } from '@cc/platform/ports'
import { useStore } from '../../store/store.js'
import { sessionFolderOf, useProjectMachine } from '../../store/selectors.js'
import { useRemoteIde } from '../machines/remoteIde.js'
import { useShortcut } from '../../app/shortcut.js'
import { formatBytes } from '../../app/format.js'
import { isPlainEnter } from '../../app/keys.js'
import { Kbd } from '../../components/primitives.jsx'
import { SkeletonLines } from '../../components/Skeleton.jsx'
import { TextInput } from '../../components/TextField.jsx'
import { Segmented } from '../../components/Segmented.jsx'
import { Markdown } from '../session/Markdown.jsx'
import { TRUNCATED_NOTICE, wholeFileText } from './copy.js'
import { useVirtualCopy } from './useVirtualCopy.js'
import { clearViewerJump, currentViewerJump, requestViewerJump, useViewerJump } from './jump.js'
import { suffixMatches } from './resolve.js'

/**
 * Code viewer (FR-6, C-3), read-only. No CodeMirror or Shiki: an editor engine is overkill here, and Shiki's default
 * engine is WASM, against Tauri's CSP (no `wasm-unsafe-eval`). Grayscale emphasis instead; "Open in IDE" for the rest.
 */
/** `sessionId`: the session whose folder the file is in (#1209), read from its worktree; null for the project's own */
export function CodeViewer({ projectId, sessionId = null }: { projectId: string; sessionId?: string | null }) {
  // An IDE on this computer cannot open another machine's file (#82); VS Code over Remote-SSH can, where it reaches
  const remote = useProjectMachine(projectId) !== null
  const remoteIde = useRemoteIde(projectId)
  const platform = usePlatform()
  const path = useStore((s) => s.viewerPath)
  const setToast = useStore((s) => s.setToast)
  // Hooks come before the `if (!path)` early return below — placed after it, the hook count would differ per render
  const sc = useShortcut()
  const jump = useViewerJump()
  const [file, setFile] = useState<FsFile | null>(null)
  /**
   * Shown on screen, not only as a toast: an agent's path is unchecked (`parseFileRef`), so a missing file is ordinary,
   * and this overlay covers the 2.5s toast's lane, which would leave "Loading…" forever.
   */
  const [error, setError] = useState<string | null>(null)
  /** Several files end with the written path (resolve.ts): the person picks, as picking for them would be a guess */
  const [candidates, setCandidates] = useState<string[]>([])
  /** A place already opened once — so if even that file cannot be read, the same place is not reopened forever */
  const resolved = useRef(new Set<string>())
  /** The row a `path:123` click asked for — highlighted, because landing mid-file is disorienting */
  const [landedIndex, setLandedIndex] = useState(-1)
  const [query, setQuery] = useState('')
  /** An SVG is both source and a picture, so the person picks which one to look at. */
  const [svgPreview, setSvgPreview] = useState(true)
  const markdownView = useStore((s) => s.viewerMarkdown)
  // A link in a rendered file opens as the same link in the conversation would, from the folder the file was read in
  const root = useStore((s) => (sessionId ? sessionFolderOf(s, sessionId) : (s.projects[projectId]?.path ?? null)))
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  /**
   * The widest row drawn so far in this file (#139): an absolute row cannot widen its parent, so a `w-full` row paints
   * only the visible width, and scrolling right loses a short row's background and sticky line number (GitPanel's
   * `w-max min-w-full` covers only long lines). Only drawn rows can be measured; it never shrinks, so the view does not
   * jump left when a long line scrolls away.
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
      .readFile(projectId, path, sessionId ?? undefined)
      .then((f) => alive && setFile(f))
      .catch((e: unknown) => {
        if (!alive) return
        // Not at the root is not a dead link (resolve.ts). Searched only after the read failed; the host holds the index
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
              // The line was asked for under the old path; ask again under the new one
              const jumpNow = currentViewerJump()
              if (jumpNow?.path === path) requestViewerJump(target, jumpNow.line)
              useStore.getState().openFile(target, projectId, sessionId)
              return
            }
            setCandidates(found.slice(0, 8))
            setError(errorMessage(e))
            // No reason to stack a toast on top when the screen is already asking the person to pick a candidate
            if (found.length === 0) setToast(errorMessage(e))
          })
      })
    return () => {
      alive = false
    }
  }, [platform, projectId, sessionId, path, setToast])

  const image = file?.image && isViewerImage(file.image) ? file.image : null
  const isSvg = image?.mime === 'image/svg+xml'
  const markdown = !!file && !file.binary && MARKDOWN.test(path ?? '')
  // A line link lands in the text while that landing stands; the view the person picked stays as it was (#2454)
  const byLine = jump?.path === path || landedIndex >= 0
  const view = isSvg ? (svgPreview ? 'rendered' : 'text') : markdown ? (byLine ? 'text' : markdownView) : null
  const showingImage = !!image && (!isSvg || svgPreview)
  const showingRendered = markdown && view === 'rendered'
  const pickView = (v: 'rendered' | 'text') => {
    if (isSvg) return setSvgPreview(v === 'rendered')
    setLandedIndex(-1)
    useStore.getState().setViewerMarkdown(v)
  }
  const lines = useMemo(() => (file?.text ?? '').split('\n'), [file])
  const matches = useMemo(() => {
    if (!query.trim()) return new Set<number>()
    const q = query.toLowerCase()
    const hit = new Set<number>()
    lines.forEach((l, i) => l.toLowerCase().includes(q) && hit.add(i))
    return hit
  }, [lines, query])
  // Enter and ⇧Enter step through matches, wrapping (#183): in a virtual list an off-screen match is not found by eye
  const matchLines = useMemo(() => [...matches], [matches])
  const [matchAt, setMatchAt] = useState(-1)
  useEffect(() => setMatchAt(-1), [matchLines])

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 30,
  })

  const stepMatch = (dir: 1 | -1) => {
    const n = matchLines.length
    if (n === 0) return
    const next = matchAt < 0 ? (dir === 1 ? 0 : n - 1) : (matchAt + dir + n) % n
    setMatchAt(next)
    virtualizer.scrollToIndex(matchLines[next]!, { align: 'center' })
  }

  // Lands on a `path:123` line (#39), once `file` has rows. Clamped: an agent's line can outrun a stale or truncated file
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
  }, [virtualItems, file, showingImage, showingRendered, rowsWidth])

  // Copy and ⌘A over rows that are not all mounted: one rule with the diff (useVirtualCopy)
  const copyLines = useMemo(() => lines.map((text) => ({ text })), [lines])
  const wholeText = useMemo(() => (file ? wholeFileText(file.text, file.truncated) : null), [file])
  const copyProps = useVirtualCopy({
    scrollRef,
    rowsRef,
    lines: copyLines,
    wholeText,
    resetKey: path,
    ready: !!file && !showingImage && !showingRendered,
  })

  if (!path) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2" data-testid="viewer-empty">
        <p className="text-md text-ink-muted">Select a file</p>
        <p className="text-xs text-ink-faint">
          <Kbd>{sc('mod', '⇧2')}</Kbd> pick a file in the tree to open it here
        </p>
      </div>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="code-viewer">
      {/* The panel's tab row height (31px, PanelTabs), so this bar's line meets the tabs' line beside it */}
      <header className="flex h-[31px] shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="readout truncate text-xs text-ink-muted" title={path} data-testid="viewer-path">
          {path}
        </span>
        {/*
          Right after the path (#2454). The search keeps its room while the other view shows, so the switch stays at one
          place in both; in a narrow window the path and the search give way.
        */}
        {view && (
          <Segmented
            label="View"
            size="sm"
            className="shrink-0"
            value={view}
            onChange={pickView}
            options={[
              { value: 'rendered', label: isSvg ? 'Preview' : 'Rendered', testId: 'viewer-view-rendered' },
              { value: 'text', label: 'Text', testId: 'viewer-view-text' },
            ]}
            testId="viewer-view"
          />
        )}
        {(view || !showingImage) && (
          <>
            <TextInput
              size="xs"
              surface="raised"
              className={`ml-2 w-40 min-w-16 ${view === 'rendered' ? 'invisible' : ''}`}
              aria-hidden={view === 'rendered' || undefined}
              placeholder="Search in file"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (!isPlainEnter(e.nativeEvent)) return
                e.preventDefault()
                stepMatch(e.shiftKey ? -1 : 1)
              }}
              data-testid="viewer-search"
            />
            {query && view !== 'rendered' && (
              <span className="readout shrink-0 text-2xs text-ink-faint" data-testid="viewer-match-count">
                {matchAt >= 0 ? `${matchAt + 1}/${matchLines.length}` : `${matches.size} lines`}
              </span>
            )}
          </>
        )}
        {!remote && (
          <button
            className="ml-auto shrink-0 text-xs text-ink-faint hover:text-ink"
            onClick={() => {
              void platform.fs
                .resolve(projectId, path, sessionId ?? undefined)
                .then(({ path: abs }) => platform.system.openInIde(abs))
                .catch((e) => setToast(`Could not open in IDE: ${errorMessage(e)}`))
            }}
            data-testid="viewer-open-ide"
          >
            Open in IDE
          </button>
        )}
        {remoteIde && (
          <button
            className="ml-auto shrink-0 text-xs text-ink-faint hover:text-ink"
            onClick={() => void remoteIde.open(path, {})}
            title={remoteIde.title}
            data-testid="viewer-open-ide"
          >
            {remoteIde.label}
          </button>
        )}
      </header>

      {error !== null ? (
        <div className="p-3">
          <p className="text-sm text-ink-muted" data-testid="viewer-error">
            Could not open this file — {error}
          </p>
          {candidates.length > 0 && (
            <div className="mt-2" data-testid="viewer-candidates">
              <p className="text-xs text-ink-faint">
                Files ending in <span className="readout text-ink-muted">{path}</span> — did you mean:
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
                        useStore.getState().openFile(c, projectId, sessionId)
                      }}
                      className="readout rounded-md px-1 py-0.5 text-left text-xs text-ink underline decoration-ink-faint underline-offset-2 hover:decoration-ink"
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
        <SkeletonLines lines={8} className="p-3" label="Loading the file" />
      ) : showingImage && image ? (
        <div
          key="image"
          className={`${view ? 'cc-fade ' : ''}flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto bg-surface-floor p-4`}
          data-testid="viewer-image"
        >
          <img
            src={`data:${image.mime};base64,${image.data}`}
            alt={`Preview of ${path}`}
            className="max-h-full max-w-full object-contain"
            data-testid="viewer-image-content"
          />
          <p className="readout shrink-0 text-2xs text-ink-faint">{formatBytes(file.bytes)}</p>
        </div>
      ) : file.binary ? (
        <p className="p-3 text-sm text-ink-faint" data-testid="viewer-binary">
          {file.previewError ?? `Binary file (${formatBytes(file.bytes)})`}
        </p>
      ) : showingRendered ? (
        // The conversation's renderer and reading width (#2454): on a wide window the right side stays empty
        <div key="rendered" className="cc-fade min-h-0 flex-1 overflow-auto px-4 py-3" data-testid="viewer-rendered">
          <Markdown text={file.text} projectRoot={root} projectId={projectId} linkSessionId={sessionId} />
          {file.truncated && <p className="pt-2 text-xs text-ink-faint">{TRUNCATED_NOTICE}</p>}
        </div>
      ) : (
        /*
         * `tabIndex={0}` region, as GitPanel's diff (#139): it scrolls sideways, and at -1 the keyboard could not come back
         * once focus left. Named just `Code`: the header states the path. 18px is estimateSize's row height, a number, not
         * a step of the line-height scale, so a theme's `--leading-code` cannot desynchronise the rows from it.
         */
        <div
          key="text"
          ref={scrollRef}
          role="region"
          aria-label="Code"
          tabIndex={0}
          className={`${view ? 'cc-fade ' : ''}min-h-0 flex-1 overflow-auto font-mono text-xs leading-[18px] focus:outline-none`}
          {...copyProps}
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
                    ? 'bg-surface-hover'
                    : matches.has(v.index) || v.index === landedIndex
                      ? 'bg-surface-hover/50'
                      : ''
                }`}
                style={{ top: `${v.start}px`, height: `${v.size}px` }}
              >
                <span className="sticky left-0 w-12 shrink-0 select-none bg-surface-floor pr-2 text-right text-ink-faint">
                  {v.index + 1}
                </span>
                <span data-code className="whitespace-pre text-ink-muted">
                  {lines[v.index]}
                </span>
              </div>
            ))}
          </div>
          {file.truncated && <p className="p-2 text-xs text-ink-faint">{TRUNCATED_NOTICE}</p>}
        </div>
      )}
    </section>
  )
}

/** A Markdown file opens rendered, with its text one switch away (#2454) */
const MARKDOWN = /\.(md|markdown)$/i

/** The host is the primary gate; this keeps a malformed adapter response from becoming a data URL. */
function isViewerImage(image: NonNullable<FsFile['image']>): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'].includes(
    image.mime,
  )
}
