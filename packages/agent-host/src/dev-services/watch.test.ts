import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirWatchers, MAX_WATCHED_DIRS } from './watch.js'

/**
 * Checked against the real filesystem — this module's contract is not "when the OS gives an
 * event" but "when a file actually changes." fs.watch's event shape differs by platform (macOS
 * lumps things together as rename), and a mocked event cannot catch that difference.
 */

const dirs: string[] = []
const watchers: DirWatchers[] = []

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-watch-'))
  dirs.push(d)
  return d
}

function makeWatcher(onChange: (projectId: string, dirs: string[]) => void, flushMs = 80): DirWatchers {
  const w = new DirWatchers(onChange, flushMs)
  watchers.push(w)
  return w
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

afterEach(() => {
  for (const w of watchers.splice(0)) w.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('DirWatchers — watches only expanded directories (#34)', () => {
  /*
   * macOS's fs.watch (FSEvents) starts its stream asynchronously, so **a change right after the
   * watch begins can be missed** (this was actually missed running the full suite — it passes on
   * its own). In the app, the next change catches it, so the contract is "notices eventually," and
   * the test checks exactly that contract: it keeps writing until an event arrives. Writing once
   * and waiting would turn the OS's own startup delay into a test failure.
   */
  it('a file created from outside is reported by its directory', async () => {
    const root = tmp()
    mkdirSync(join(root, 'src'))
    const got: string[][] = []
    const w = makeWatcher((_p, d) => got.push(d))
    expect(w.setWatched('p1', root, ['', 'src'])).toBe(2)

    for (let i = 0; i < 30 && got.length === 0; i++) {
      writeFileSync(join(root, 'src', `new${i}.ts`), 'x')
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(got.flat()).toContain('src')
  })

  /*
   * Measured: writing 500 files took 36ms and fired 501 events. Reading again on every event would
   * be 500 listing requests — the contract this test checks is "far fewer notifications than
   * events." Not "exactly once": once a burst runs longer than the flush window (80ms), keeping up
   * with one notification per interval is **the design** (why the screen never starves through an
   * entire npm install). Under the load of the full suite, writing 100 files once ran past the
   * window and became two notifications — that was not a failure.
   */
  it('one burst (100 files) folds into far fewer notifications than events', async () => {
    const root = tmp()
    const got: string[][] = []
    const w = makeWatcher((_p, d) => got.push(d))
    w.setWatched('p1', root, [''])
    // Fires the burst only after clearing FSEvents's startup delay (see the comment above) — what is measured here is folding, not startup
    await new Promise((r) => setTimeout(r, 300))

    for (let i = 0; i < 100; i++) writeFileSync(join(root, `f${i}.txt`), 'x')
    await until(() => got.length > 0)
    // counted only after giving time for any remaining flush to arrive
    await new Promise((r) => setTimeout(r, 300))
    expect(got.length).toBeLessThanOrEqual(4)
    expect(got.flat()).toContain('')
  })

  it('a directory removed from the set is no longer reported — folding it closes the eye too', async () => {
    const root = tmp()
    mkdirSync(join(root, 'sub'))
    const got: string[][] = []
    const w = makeWatcher((_p, d) => got.push(d))
    w.setWatched('p1', root, ['sub'])
    expect(w.setWatched('p1', root, [])).toBe(0)

    writeFileSync(join(root, 'sub', 'after.txt'), 'x')
    await new Promise((r) => setTimeout(r, 300))
    expect(got).toEqual([])
  })

  it('deleting a watched directory reports that fact — so the screen can clear it', async () => {
    const root = tmp()
    mkdirSync(join(root, 'doomed'))
    const got: string[][] = []
    const w = makeWatcher((_p, d) => got.push(d))
    w.setWatched('p1', root, ['doomed'])
    await new Promise((r) => setTimeout(r, 300))

    rmSync(join(root, 'doomed'), { recursive: true })
    await until(() => got.flat().includes('doomed'))
    expect(got.flat()).toContain('doomed')
  })

  it('asked to watch an already-gone directory, reports that fact instead of watching', async () => {
    const root = tmp()
    const got: string[][] = []
    const w = makeWatcher((_p, d) => got.push(d))
    w.setWatched('p1', root, ['never-existed'])

    await until(() => got.length > 0)
    expect(got.flat()).toContain('never-existed')
  })

  it('a path outside the project cannot join the set — the same rule as every other fs path in the tree', () => {
    const root = tmp()
    const w = makeWatcher(() => {})
    expect(w.setWatched('p1', root, ['../outside'])).toBe(0)
  })

  it('a link directory pointing outside is never watched', () => {
    const root = tmp()
    const outside = tmp()
    symlinkSync(outside, join(root, 'linked'), 'dir')
    const w = makeWatcher(() => {})

    expect(w.setWatched('p1', root, ['linked'])).toBe(0)
  })

  it('a broken link is never turned into a missing-folder notification', async () => {
    const root = tmp()
    const got: string[][] = []
    symlinkSync(join(root, 'missing'), join(root, 'dangling'))
    const w = makeWatcher((_p, d) => got.push(d), 40)

    expect(w.setWatched('p1', root, ['dangling'])).toBe(0)
    await new Promise((r) => setTimeout(r, 120))
    expect(got).toEqual([])
  })

  it('hitting the cap returns the number actually kept — it never silently truncates', () => {
    const root = tmp()
    // 300 real subdirectories, more than the cap: only a directory that exists is watched, so all 300 are
    // created, and the count that comes back is the cap — the caller can tell the list was cut
    for (let i = 0; i < 300; i++) mkdirSync(join(root, `d${i}`))
    const w = makeWatcher(() => {})
    const rels = Array.from({ length: 300 }, (_, i) => `d${i}`)
    expect(w.setWatched('p1', root, rels)).toBe(MAX_WATCHED_DIRS)
  })
})

/**
 * Watching leaked through the same split too (#119).
 *
 * Walking with `..` left unfolded made the guard follow the link and then climb to a parent,
 * while the path a watch was actually attached to was the one `safeJoin` had already folded first.
 * That means a live watcher ends up attached to a directory outside the project — which means we
 * are listening in on what happens in someone else's folder.
 */
describe('a .. past a symlink cannot watch outside (#119)', () => {
  it('no watch was set up', () => {
    const root = tmp()
    const outside = tmp()
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
    mkdirSync(join(root, 'sub', 'evil'))
    symlinkSync(join(root, 'sub', 'deep'), join(root, 'link'))
    symlinkSync(outside, join(root, 'evil'))

    const w = makeWatcher(() => {})
    watchers.push(w)
    expect(w.setWatched('p', root, ['link/../evil'])).toBe(0)
  })
})
