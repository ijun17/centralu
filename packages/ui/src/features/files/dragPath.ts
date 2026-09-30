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
  return [...dt.types].includes('Files')
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
 */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes('Files') || types.includes(PATH_MIME)
}
