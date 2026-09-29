import { lstatSync, watch, type FSWatcher } from 'node:fs'
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

export class DirWatchers {
  /** projectId -> (relative path -> watcher) */
  private byProject = new Map<string, Map<string, FSWatcher>>()
  private pending = new Map<string, Set<string>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false

  constructor(
    private onChange: (projectId: string, dirs: string[]) => void,
    private flushMs = 300,
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
    const cur = this.byProject.get(projectId) ?? new Map<string, FSWatcher>()
    this.byProject.set(projectId, cur)

    for (const [rel, w] of cur) {
      if (!want.has(rel)) {
        w.close()
        cur.delete(rel)
      }
    }

    for (const rel of want) {
      if (cur.has(rel)) continue
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
        cur.delete(rel)
        this.schedule(projectId, rel)
      })
      cur.set(rel, w)
    }
    return cur.size
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

  close(): void {
    this.closed = true
    for (const m of this.byProject.values()) for (const w of m.values()) w.close()
    this.byProject.clear()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.pending.clear()
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}
