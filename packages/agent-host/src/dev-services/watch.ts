import { lstatSync, watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'
import { wireJoin, wireParent } from '@cc/protocol'
import { locksWatchedFolders } from '../os.js'
import { safeJoin } from './fs.js'
import { assertExistingPathSync, isMissingPathError } from './path-guard.js'

/**
 * The eyes of the file tree (#34) — watches **only expanded directories.**
 *
 * The reason this does not recursively watch the whole repository is the whole point of this
 * design. The tree is lazy, so only a directory that has actually been opened is read — a
 * recursive watch would walk into node_modules too, undoing that laziness by hand (Linux's
 * inotify has no recursion, so it is one watch per directory — exhausting max_user_watches, the
 * famous ENOSPC). The expanded set is only the handful to a few dozen a screen actually shows, so
 * the numbers stay the same across all three platforms.
 *
 * Events are gathered per directory and emitted **once per interval.** Measured: writing 500
 * files took 36ms and fired 501 events — reading again on every event would be 500 listing
 * requests. A debounce that only ever defers would starve the screen for the whole length of a
 * burst like npm install, which can run tens of seconds. Flushing on an interval keeps up at up
 * to 3 to 4 times a second even during a burst.
 */

/**
 * The watch cap per project. In real use, expanded folders never reach this (it would take
 * expanding hundreds by hand), but if it is reached, this **never silently truncates** — it
 * returns how many are actually being watched, so the caller knows from that count that it was cut
 * off.
 */
export const MAX_WATCHED_DIRS = 256

/**
 * One project's watch set: the expanded folders, each with a watcher of its own, or (`locksWatchedFolders`, Windows)
 * none of their own and one recursive watcher on the root (`tree`) that stands in for all of them.
 */
type ProjectWatch = { dirs: Map<string, FSWatcher | null>; tree: { root: string; watcher: FSWatcher } | null }

export class DirWatchers {
  private byProject = new Map<string, ProjectWatch>()
  private pending = new Map<string, Set<string>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false

  constructor(
    private onChange: (projectId: string, dirs: string[]) => void,
    private flushMs = 300,
    /**
     * Windows (#849): a watcher per expanded folder held each one open, so renaming or moving it or any folder above
     * it failed with EPERM, from the file tree, an agent's `mv` or git alike (measured: `src` with `src/components`
     * expanded). One recursive watcher on the root holds only the root, and its events are matched to the expanded
     * folders here. Windows watches a tree natively (one handle, no walk), so the reason for not watching recursively
     * elsewhere (above) does not apply there.
     */
    private oneTree = locksWatchedFolders(),
  ) {}

  /**
   * Makes this project's watch set **exactly this, as a whole** (the same grammar as
   * projects.reorder). An "add this, remove that" style would let the screen and the watch set
   * drift apart with no error ever raised — stating the whole set makes that drift impossible to
   * even express.
   */
  setWatched(projectId: string, root: string, rels: readonly string[]): number {
    if (this.closed) return 0
    const want = new Set([...new Set(rels)].slice(0, MAX_WATCHED_DIRS))
    const cur = this.byProject.get(projectId) ?? { dirs: new Map<string, FSWatcher | null>(), tree: null }
    this.byProject.set(projectId, cur)

    for (const [rel, w] of cur.dirs) {
      if (!want.has(rel)) {
        w?.close()
        cur.dirs.delete(rel)
      }
    }

    for (const rel of want) {
      if (cur.dirs.has(rel)) continue
      let abs = ''
      try {
        // the same rule as every other fs path in the tree — neither outside the project nor a link can be watched
        abs = safeJoin(root, rel)
        const info = assertExistingPathSync(root, rel)
        if (!info.isDirectory()) continue
      } catch (error) {
        if (isMissingPathError(error) && !isSymlink(abs)) this.schedule(projectId, rel)
        continue
      }
      if (this.oneTree) {
        cur.dirs.set(rel, null)
        continue
      }
      let w: FSWatcher
      try {
        w = watch(abs, () => this.schedule(projectId, rel))
      } catch {
        /*
         * A directory that vanished after the path check (a folder deleted from Finder while it
         * was expanded). It cannot be watched, but **that fact itself is worth reporting** —
         * reporting it once lets the UI read again, and an empty list combined with the parent
         * being refetched clears it from the screen.
         */
        this.schedule(projectId, rel)
        continue
      }
      w.on('error', () => {
        // the directory being watched has disappeared — the watcher is removed, and the screen is told
        w.close()
        cur.dirs.delete(rel)
        this.schedule(projectId, rel)
      })
      cur.dirs.set(rel, w)
    }
    if (this.oneTree) this.watchTree(projectId, cur, root)
    return cur.dirs.size
  }

  /** The one recursive watcher of a project whose folders are not watched one by one: there while any folder is expanded */
  private watchTree(projectId: string, cur: ProjectWatch, root: string): void {
    const abs = resolve(root)
    if (cur.tree && (cur.dirs.size === 0 || cur.tree.root !== abs)) {
      cur.tree.watcher.close()
      cur.tree = null
    }
    if (cur.tree || cur.dirs.size === 0) return
    const lost = () => {
      // the root itself is gone: every expanded folder went with it, and the screen is told about each
      cur.tree?.watcher.close()
      cur.tree = null
      for (const rel of cur.dirs.keys()) this.schedule(projectId, rel)
      cur.dirs.clear()
    }
    let watcher: FSWatcher
    try {
      watcher = watch(abs, { recursive: true }, (event, name) => this.treeEvent(projectId, cur, event, name))
    } catch {
      return lost()
    }
    watcher.on('error', lost)
    cur.tree = { root: abs, watcher }
  }

  /**
   * One event of a project's recursive watcher, as the watchers of single folders would have reported it: the folder
   * an entry changed in, the entry itself when it is an expanded folder (deleted or renamed), and on a rename every
   * expanded folder under it, which moved or went with it. No name (the OS dropped events) reports them all.
   */
  private treeEvent(projectId: string, cur: ProjectWatch, event: string, name: string | null): void {
    if (cur.dirs.size === 0) return
    if (!name) {
      for (const rel of cur.dirs.keys()) this.schedule(projectId, rel)
      return
    }
    // The OS's separator (a backslash on Windows) to the wire's, which the expanded folders are named in
    const rel = wireJoin(...name.split(/[\\/]+/))
    const parent = wireParent(rel)
    if (cur.dirs.has(parent)) this.schedule(projectId, parent)
    if (cur.dirs.has(rel)) this.schedule(projectId, rel)
    if (event !== 'rename') return
    for (const dir of cur.dirs.keys()) if (dir.startsWith(`${rel}/`)) this.schedule(projectId, dir)
  }

  private schedule(projectId: string, rel: string): void {
    if (this.closed) return
    const set = this.pending.get(projectId) ?? new Set<string>()
    set.add(rel)
    this.pending.set(projectId, set)
    if (this.timers.has(projectId)) return
    const t = setTimeout(() => {
      this.timers.delete(projectId)
      const dirs = [...(this.pending.get(projectId) ?? [])]
      this.pending.delete(projectId)
      if (dirs.length && !this.closed) this.onChange(projectId, dirs)
    }, this.flushMs)
    // a single pending flush must never hold up the host shutting down
    t.unref?.()
    this.timers.set(projectId, t)
  }

  /**
   * Lets go of one project for good (#392). A deleted project's folder stays on disk and could keep firing,
   * and nothing can unwatch it afterwards: the screen's unwatch names a project the host no longer knows.
   */
  drop(projectId: string): void {
    const cur = this.byProject.get(projectId)
    if (cur) closeAll(cur)
    this.byProject.delete(projectId)
    const t = this.timers.get(projectId)
    if (t) clearTimeout(t)
    this.timers.delete(projectId)
    this.pending.delete(projectId)
  }

  /** How many directories of this project are being watched */
  watchedCount(projectId: string): number {
    return this.byProject.get(projectId)?.dirs.size ?? 0
  }

  close(): void {
    this.closed = true
    for (const cur of this.byProject.values()) closeAll(cur)
    this.byProject.clear()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.pending.clear()
  }
}

function closeAll(cur: ProjectWatch): void {
  for (const w of cur.dirs.values()) w?.close()
  cur.tree?.watcher.close()
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
