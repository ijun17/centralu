import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { usePlatform } from '../../app/PlatformProvider.jsx'
import { useStore } from '../../store/store.js'
import { useShortcut } from '../../app/shortcut.js'
import { Kbd } from '../../components/primitives.jsx'
import { TRUNCATED_NOTICE, caretAt, selectedText, wholeFileText, type Caret } from './copy.js'
import { clearViewerJump, useViewerJump } from './jump.js'

/**
 * 코드 뷰어 (FR-6, C-3) — **읽기 전용**. 편집은 IDE 몫이다 (비목표).
 *
 * 무거운 것을 넣지 않는 것이 이 화면의 설계다:
 *   - CodeMirror·Shiki를 쓰지 않는다. 읽기 전용 표시에 편집기 엔진은 과하고,
 *     Shiki의 기본 엔진은 WASM이라 Tauri CSP(`wasm-unsafe-eval` 없음)와 충돌한다.
 *   - 대신 가상 스크롤 + 무채색 강조(주석·문자열만 밝기로 구분)로 충분히 읽힌다.
 *   - 정밀한 하이라이트가 필요하면 "IDE에서 열기"가 한 번의 클릭이다.
 */
export function CodeViewer({ projectId }: { projectId: string }) {
  const platform = usePlatform()
  const path = useStore((s) => s.viewerPath)
  const setToast = useStore((s) => s.setToast)
  // 훅은 아래 `if (!path)` 이른 return보다 먼저 — 분기 뒤에 두면 렌더마다 훅 수가 달라진다
  const sc = useShortcut()
  const jump = useViewerJump()
  const [file, setFile] = useState<{ text: string; truncated: boolean; binary: boolean; bytes: number } | null>(null)
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
  /** The row a `path:123` click asked for — highlighted, because landing mid-file is disorienting */
  const [landedIndex, setLandedIndex] = useState(-1)
  const [query, setQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  /** ⌘A was pressed and no new selection has started since — copy owes the whole file */
  const wholeFile = useRef(false)
  /** The last readable anchor of the current selection (see `selectedText`) */
  const anchor = useRef<Caret | null>(null)
  const focusedFor = useRef<string | null>(null)

  useEffect(() => {
    setFile(null)
    setError(null)
    setLandedIndex(-1)
    if (!path) return
    // 파일·프로젝트를 옮기는 사이 늦게 온 응답이 **다른 파일의 내용**으로 그려지면 안 된다
    let alive = true
    void platform.fs
      .readFile(projectId, path)
      .then((f) => alive && setFile(f))
      .catch((e: Error) => {
        if (!alive) return
        setError(e.message)
        setToast(e.message)
      })
    return () => {
      alive = false
    }
  }, [platform, projectId, path, setToast])

  const lines = useMemo(() => (file?.text ?? '').split('\n'), [file])
  const matches = useMemo(() => {
    if (!query.trim()) return new Set<number>()
    const q = query.toLowerCase()
    const hit = new Set<number>()
    lines.forEach((l, i) => l.toLowerCase().includes(q) && hit.add(i))
    return hit
  }, [lines, query])

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
  useEffect(() => {
    if (!file || !jump || jump.path !== path) return
    clearViewerJump()
    const index = Math.min(jump.line, lines.length) - 1
    setLandedIndex(index)
    virtualizer.scrollToIndex(index, { align: 'center' })
  }, [file, jump, path, lines.length, virtualizer])

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
    if (!file) return
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
  }, [file, lines])

  /**
   * ⌘A has to land somewhere. The code area is not a text field, so it takes focus once the
   * file is on screen — otherwise the key would reach the window and mean nothing here.
   * Once per opened path, so it never steals the search box back mid-typing.
   */
  useEffect(() => {
    if (!file || focusedFor.current === path) return
    focusedFor.current = path
    wholeFile.current = false
    scrollRef.current?.focus()
  }, [file, path])

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
        <input
          className="ml-2 w-40 rounded border border-edge bg-panel px-2 py-0.5 text-[11px] text-chalk placeholder:text-slate focus:border-graphite focus:outline-none"
          placeholder="Search in file"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="viewer-search"
        />
        {query && (
          <span className="readout text-[10px] text-slate" data-testid="viewer-match-count">
            {matches.size} lines
          </span>
        )}
        <button
          className="ml-auto shrink-0 text-[11px] text-slate hover:text-chalk"
          onClick={() => void platform.system.openInIde(path)}
          data-testid="viewer-open-ide"
        >
          Open in IDE
        </button>
      </header>

      {error !== null ? (
        <p className="p-3 text-[12px] text-ash" data-testid="viewer-error">
          Could not open this file — {error}
        </p>
      ) : file === null ? (
        <p className="p-3 text-[12px] text-slate">Loading…</p>
      ) : file.binary ? (
        <p className="p-3 text-[12px] text-slate" data-testid="viewer-binary">
          Binary file ({(file.bytes / 1024).toFixed(0)}KB)
        </p>
      ) : (
        <div
          ref={scrollRef}
          tabIndex={-1}
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
          <div ref={rowsRef} className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((v) => (
              <div
                key={v.key}
                data-line={v.index}
                data-landed={v.index === landedIndex || undefined}
                className={`absolute left-0 flex w-full ${
                  matches.has(v.index) || v.index === landedIndex ? 'bg-graphite/50' : ''
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
