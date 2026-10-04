/**
 * Dragging a path from the file tree and dropping it into the composer.
 *
 * A dedicated MIME type is used. The composer's drop handling was originally built for **files
 * dragged in from the OS** (attachments), and without telling the two apart, something dragged from
 * the tree would also try to become an attachment, find `dataTransfer.files` empty, and
 * **nothing would happen** — the kind of silent no-op this project forbids.
 *
 * `text/plain` is carried alongside it too: a path also has to come out when dropped somewhere else
 * (a terminal, an editor).
 */
export const PATH_MIME = 'application/x-cc-path'

/**
 * Why `copyMove` (#19).
 *
 * The same drag becomes **one of two things depending on where it lands**: dropped on the composer,
 * the path goes into the sentence (a copy); dropped on a folder in the tree, the file moves there (a
 * move). If this were fixed to `copy`, the moment the tree side set `dropEffect = 'move'` the
 * browser would **reject that drop** — with no error, just nothing happening at all.
 */
export function setDragPath(dt: DataTransfer, path: string): void {
  dt.setData(PATH_MIME, path)
  dt.setData('text/plain', path)
  dt.effectAllowed = 'copyMove'
}

/** Is what was dropped our own path? Otherwise null — in that case it is treated as an attachment path */
export function readDragPath(dt: DataTransfer): string | null {
  const path = dt.getData(PATH_MIME)
  return path || null
}

/**
 * Is what is being dragged our own path — determined **without reading its content.**
 *
 * During `dragover`, `getData()` returns an empty string (the browser hides the content until it is
 * actually dropped). So "can this be accepted" can only be answered through `types`. Without this
 * distinction, the hand would have to let go without the cursor ever indicating what would happen.
 */
export function hasDragPath(dt: DataTransfer): boolean {
  return [...dt.types].includes(PATH_MIME)
}

/** Is this a file dragged in from the OS (#19's "drag it in from Finder")? */
export function hasDragFiles(dt: DataTransfer): boolean {
  return isOsFileDrag([...dt.types])
}

/**
 * The type every drag that starts in this window carries (#286), whatever was picked up.
 *
 * A drag that starts inside Centralu is never a file dropped in from the OS, whatever else the
 * engine adds to it. WebKit adds the images inside a dragged element to the drag as files: in the
 * packaged app, dragging a grid panel whose conversation showed a screenshot carried `Files` next
 * to the session type, and the session panel it was dropped on attached the screenshot instead of
 * the grid placing the session.
 *
 * Why a mark put on at `dragstart` rather than a list of our own types: a list only covers the
 * draggables that remember to set one of them. The mark is put on by one listener on the window,
 * in the capture phase (`markInternalDrags`), so it covers a draggable added later without anyone
 * remembering this, and the drags no handler of ours starts at all: an image, a link or selected
 * text dragged out of the conversation, which the engine may also carry as files. It sits under
 * the same `application/x-cc-` prefix as our other types, so `isInternalDrag` is one rule for
 * both, and a drag dispatched without a `dragstart` (a script, a test) is still told apart by its
 * own type.
 *
 * What it cannot see: a drag that starts in another document, such as an app's frame.
 */
export const INTERNAL_DRAG_MIME = 'application/x-cc-internal'

const INTERNAL_PREFIX = 'application/x-cc-'

/**
 * Marks every drag that starts in `win` as ours, until the returned function is called.
 *
 * Capture on the window, so it runs before any element's own `dragstart` and nothing below can
 * stop it with `stopPropagation`. The data is not empty: an empty string is not reliably kept as a
 * type.
 */
export function markInternalDrags(win: Window): () => void {
  const mark = (e: DragEvent) => e.dataTransfer?.setData(INTERNAL_DRAG_MIME, '1')
  const opts = { capture: true } as const
  win.addEventListener('dragstart', mark, opts)
  return () => win.removeEventListener('dragstart', mark, opts)
}

/**
 * Did this drag start inside Centralu? Any type of ours says so: the mark, a session, a project,
 * a panel, a panel tab, an app, a file-tree path.
 */
export function isInternalDrag(types: readonly string[]): boolean {
  return types.some((t) => t.startsWith(INTERNAL_PREFIX))
}

/**
 * Is this a file dropped in from outside the app, to be attached or imported?
 *
 * `Files` alone is not enough (#286): our own drags can carry it too, see `INTERNAL_DRAG_MIME`.
 */
export function isOsFileDrag(types: readonly string[]): boolean {
  return types.includes('Files') && !isInternalDrag(types)
}

/**
 * Appends `@path` to the composer's text.
 *
 * **Must produce the same shape** as autocomplete inserting a file with `@` — with two ways to
 * insert a file, a different result would mean the tool receives a different sentence.
 */
export function appendPath(text: string, path: string): string {
  const mention = `@${path}`
  if (!text) return `${mention} `
  return /\s$/.test(text) ? `${text}${mention} ` : `${text} ${mention} `
}

/**
 * Is this a drag the session panel should accept (#116)?
 *
 * Making the whole panel a drop target meant it **now shares the same surface as reordering** — a
 * grid panel is also a place where panels swap positions with each other, and the sidebar's sessions
 * and projects are also dragged with their own MIME types. So what to accept is written as **an
 * explicit list.** Writing it as "accept anything that is not that other thing" would mean, every
 * time a new MIME type is added, the panel silently swallows someone else's drop, and that would only
 * ever surface as nothing happening, with no error.
 *
 * The two things accepted do different work behind the scenes: an OS file becomes an attachment,
 * while a path dragged from the tree goes into the sentence (exactly the composer's own drop
 * handling). This function only decides "is this a drag this spot should answer."
 *
 * An OS file is `isOsFileDrag`, not `Files` alone: a session or panel dragged inside the app can
 * carry `Files` too (#286), and its drop belongs to the grid.
 */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes(PATH_MIME) || isOsFileDrag(types)
}
