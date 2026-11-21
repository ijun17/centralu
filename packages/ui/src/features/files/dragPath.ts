// A path dragged from the file tree. Its own type tells it from an OS file, which the composer would try to attach and
// silently drop with `files` empty; `text/plain` rides along so a terminal or editor gets the path too.
export const PATH_MIME = 'application/x-cc-path'

/**
 * `copyMove` (#19): on the composer the path is copied into the text, on a tree folder the file moves. A fixed `copy`
 * makes the browser silently reject the tree's `dropEffect = 'move'`.
 */
export function setDragPath(dt: DataTransfer, path: string): void {
  dt.setData(PATH_MIME, path)
  dt.setData('text/plain', path)
  dt.effectAllowed = 'copyMove'
}

/** null: not our path, so an attachment */
export function readDragPath(dt: DataTransfer): string | null {
  const path = dt.getData(PATH_MIME)
  return path || null
}

/** By `types` alone: `getData()` is empty until the drop, and the cursor must say what a drop will do before it */
export function hasDragPath(dt: DataTransfer): boolean {
  return [...dt.types].includes(PATH_MIME)
}

/** A file from the OS (#19) */
export function hasDragFiles(dt: DataTransfer): boolean {
  return isOsFileDrag([...dt.types])
}

/**
 * On every drag that starts in this window (#286): WebKit adds a dragged element's images as `Files`, so a grid panel
 * showing a screenshot would be attached instead of placed. One window listener (`markInternalDrags`) covers every
 * draggable, ours or the engine's (an image, link or selection from the conversation), unlike a list of our types; its
 * `application/x-cc-` prefix lets `isInternalDrag` also catch a drag dispatched without `dragstart`. Blind to drags from
 * another document, such as an app's frame.
 */
export const INTERNAL_DRAG_MIME = 'application/x-cc-internal'

const INTERNAL_PREFIX = 'application/x-cc-'

/**
 * Capture on the window: it runs before any element's `dragstart`, and no `stopPropagation` below stops it. Non-empty
 * data, since an empty string is not reliably kept as a type.
 */
export function markInternalDrags(win: Window): () => void {
  const mark = (e: DragEvent) => e.dataTransfer?.setData(INTERNAL_DRAG_MIME, '1')
  const opts = { capture: true } as const
  win.addEventListener('dragstart', mark, opts)
  return () => win.removeEventListener('dragstart', mark, opts)
}

/** Any type of ours says so: the mark, a session, project, panel, panel tab, app or tree path */
export function isInternalDrag(types: readonly string[]): boolean {
  return types.some((t) => t.startsWith(INTERNAL_PREFIX))
}

/** `Files` alone is not enough: our own drags can carry it (#286, `INTERNAL_DRAG_MIME`) */
export function isOsFileDrag(types: readonly string[]): boolean {
  return types.includes('Files') && !isInternalDrag(types)
}

/** The same shape as `@` autocomplete inserts, so both ways give the tool the same sentence */
export function appendPath(text: string, path: string): string {
  const mention = `@${path}`
  if (!text) return `${mention} `
  return /\s$/.test(text) ? `${text}${mention} ` : `${text} ${mention} `
}

/**
 * What the session panel accepts (#116), as an explicit list: the panel shares its surface with panel swaps and sidebar
 * drags, and "anything but X" would silently swallow each new type's drop. An OS file attaches; a tree path goes into the text.
 */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes(PATH_MIME) || isOsFileDrag(types)
}
