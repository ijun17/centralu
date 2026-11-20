/**
 * The copy of the store kept before a step that breaks older readers (#2304, store/store-copy.ts).
 *
 * Real files in a temporary folder throughout: the copy is a file, written by SQLite and renamed by the OS. The store is
 * this build's, with one project in it, and "the next build" is this build's `Store` with steps added after the real
 * list: one that breaks older readers deletes the project, which is how a test tells the copy from the store.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type Database from 'better-sqlite3'
import type { Os } from '../os/port.js'
import { realOs } from '../os/real.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { Store, StoreTooNewError } from './store.js'
import type { MigrationStep } from './store/migrations/context.js'
import type { StoreWork } from './store/store-work.js'
import { SLOW } from '../../../../tooling/test-timing.js'

const { files, paths, processes, env } = realOs()
const { join } = paths.path

type StepMaker = (db: Database.Database) => MigrationStep

/** The steps the next build adds after this build's */
let added: StepMaker[] = []

class NextBuild extends Store {
  protected override migrationSteps(): MigrationStep[] {
    return [...super.migrationSteps(), ...added.map((make) => make(this.db))]
  }

  /** What the file holds: its version, its projects, and whether SQLite finds it whole */
  held(): { version: number; projects: string[]; check: unknown } {
    return {
      version: this.schemaVersion,
      projects: this.projects.listProjects().map((p) => p.id),
      check: this.db.pragma('quick_check', { simple: true }),
    }
  }
}

/** A step that breaks older readers and deletes every project */
const breaking =
  (to: number): StepMaker =>
  (db) => ({ to, breaksOlderReaders: true, run: () => void db.exec('DELETE FROM projects') })
/** A step every older build still reads past */
const expanding =
  (to: number): StepMaker =>
  () => ({ to, breaksOlderReaders: false, run: () => {} })

const stores: Store[] = []
const dirs: string[] = []
let said: MockInstance<typeof console.error>
beforeEach(() => {
  said = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  added = []
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) await removeTree(d)
})

const logged = (): string[] => said.mock.calls.map(([line]) => String(line))

/** This build's store with one project, closed: `store.db` in a folder of its own */
function storeFile(): string {
  const dir = tempRoot('cc-store-copy-')
  dirs.push(dir)
  const file = join(dir, 'store.db')
  const s = new Store(file)
  s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  s.close()
  return file
}

/** This build's newest step */
const LATEST = (() => {
  const s = new Store()
  try {
    return s.latestKnownVersion
  } finally {
    s.close()
  }
})()
const STEP = LATEST + 1

/** The store at `file` as the next build opens it, with `steps` after this build's */
function openNext(file: string, steps: StepMaker[], os?: Os): NextBuild {
  added = steps
  const s = new NextBuild(file, os)
  stores.push(s)
  return s
}

function osWith(files: Partial<Os['files']>, now?: () => number): Os {
  const real = realOs()
  return { ...real, files: { ...real.files, ...files }, clock: now ? { ...real.clock, now } : real.clock }
}

/**
 * What a database file holds, opened by a build that knows every step up to `version` and so runs none: a file at
 * another version is refused (too new) or stepped, and the version read back says which.
 */
function read(file: string, version = LATEST): ReturnType<NextBuild['held']> {
  const before = added
  added = Array.from({ length: version - LATEST }, (_, i) => expanding(LATEST + 1 + i))
  try {
    const s = new NextBuild(file)
    try {
      return s.held()
    } finally {
      s.close()
    }
  } finally {
    added = before
  }
}

const copyOf = (file: string, step = STEP): string => join(file, '..', `store.before-${step}.db`)
/** The files beside the store that are not the store's own */
const beside = (file: string): string[] =>
  files
    .readdirSync(join(file, '..'))
    .filter((name) => !/^store\.db(-wal|-shm)?$/.test(name))
    .sort()
/** Twice the store and its WAL, as they are when asked: the free space a copy is made with */
const twice = (file: string): number => 2 * (files.statSync(file).size + (files.statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0))

describe('before a step that breaks older readers', () => {
  it('the store as it was is kept beside it, whole, and the step runs', () => {
    const file = storeFile()

    const s = openNext(file, [breaking(STEP)])

    expect(s.schemaVersion).toBe(STEP)
    expect(s.projects.listProjects()).toEqual([])
    expect(s.copySkipped).toBeNull()
    expect(beside(file)).toEqual([`store.before-${STEP}.db`])
    expect(read(copyOf(file))).toEqual({ version: LATEST, projects: ['p1'], check: 'ok' })
    expect(logged().some((line) => line.includes(`copying the store`) && line.includes(copyOf(file)) && line.includes(`before step ${STEP}`))).toBe(true)
  })

  it('a store that crosses two such steps in one open keeps the one from before the first', () => {
    const file = storeFile()

    const s = openNext(file, [breaking(STEP), expanding(STEP + 1), breaking(STEP + 2)])

    expect(s.schemaVersion).toBe(STEP + 2)
    expect(beside(file)).toEqual([`store.before-${STEP}.db`])
    expect(read(copyOf(file))).toMatchObject({ version: LATEST, projects: ['p1'] })
  })

  it('the copy has the permissions of the store, not the ones a new file gets', { skip: !realOs().traits.modesGuardFiles }, () => {
    const file = storeFile()
    files.chmodSync(file, 0o600)

    openNext(file, [breaking(STEP)])

    expect(files.statSync(copyOf(file)).mode & 0o777).toBe(0o600)
  })

  it('a store wider than the creation mask allows keeps its mode in the copy', { skip: !realOs().traits.modesGuardFiles }, () => {
    const file = storeFile()
    files.chmodSync(file, 0o640)
    // A new file under this mask is made 0600 at most, so only setting the mode afterwards gives the copy the store's 0640
    const mask = process.umask(0o077)
    try {
      openNext(file, [breaking(STEP)])
    } finally {
      process.umask(mask)
    }

    expect(files.statSync(copyOf(file)).mode & 0o777).toBe(0o640)
  })

  it('the build the person had opens the copy put back in the store’s place, with what the step removed', () => {
    const file = storeFile()
    openNext(file, [breaking(STEP)]).close()
    stores.length = 0
    // The store the step left is one the build before cannot open
    expect(() => new Store(file)).toThrow(StoreTooNewError)

    // docs/agent-host/store-migrations.md "Getting the copy back"
    for (const end of ['', '-wal', '-shm']) if (files.existsSync(file + end)) files.renameSync(file + end, `${file}${end}.aside`)
    files.renameSync(copyOf(file), file)
    const before = new Store(file)
    stores.push(before)

    expect(before.schemaVersion).toBe(LATEST)
    expect(before.projects.listProjects().map((p) => p.id)).toEqual(['p1'])
  })
})

describe('what the open says while it works (#2334)', () => {
  it('says the copy while it writes it, each step while it runs, and nothing once it is done', () => {
    const file = storeFile()
    const told: (StoreWork | null)[] = []
    // What had been said when the copy asked how much room the disk has: the copy is under way by then
    let duringCopy: StoreWork | null | undefined
    const os = osWith({ freeBytesSync: () => ((duringCopy = told.at(-1)), null) }, () => 1_800_000_000_000)
    added = [breaking(STEP), expanding(STEP + 1)]
    stores.push(new NextBuild(file, os, (w) => void told.push(w)))

    const bytes = files.statSync(file).size
    expect(duringCopy).toEqual({ doing: 'copy', step: STEP, bytes: expect.any(Number), since: 1_800_000_000_000 })
    expect(told).toEqual([
      { doing: 'copy', step: STEP, bytes: expect.any(Number), since: 1_800_000_000_000 },
      { doing: 'update', step: STEP, bytes: expect.any(Number), since: 1_800_000_000_000 },
      { doing: 'update', step: STEP + 1, bytes: expect.any(Number), since: 1_800_000_000_000 },
      null,
    ])
    expect((told[0] as StoreWork).bytes).toBeGreaterThanOrEqual(bytes)
  })

  it('says nothing for a store that is new, or that has no step to run, and the work of the open that has one', () => {
    const told: (StoreWork | null)[] = []
    const dir = tempRoot('cc-store-copy-')
    dirs.push(dir)
    stores.push(new Store(join(dir, 'store.db'), realOs(), (w) => void told.push(w)))
    const file = storeFile()
    stores.push(new Store(file, realOs(), (w) => void told.push(w)))
    expect(told).toEqual([])

    // The same store, opened by the build with a step to run
    added = [breaking(STEP)]
    stores.push(new NextBuild(file, realOs(), (w) => void told.push(w)))
    expect(told.map((w) => w?.doing ?? null)).toEqual(['copy', 'update', null])
  })
})

describe('no copy is made', () => {
  it('for a step every older build reads past', () => {
    const file = storeFile()

    const s = openNext(file, [expanding(STEP)])

    expect(s.schemaVersion).toBe(STEP)
    expect(beside(file)).toEqual([])
  })

  it('of a store that is new: there is nothing in it to keep', () => {
    const dir = tempRoot('cc-store-copy-')
    dirs.push(dir)
    const file = join(dir, 'store.db')

    const s = openNext(file, [breaking(STEP)])

    expect(s.schemaVersion).toBe(STEP)
    expect(s.copySkipped).toBeNull()
    expect(beside(file)).toEqual([])
  })

  it('of a store in memory', () => {
    class Again extends NextBuild {
      /** The next build's steps run on a store this build opened, as a test's own upgrade does */
      upgrade(): void {
        added = [breaking(STEP)]
        this.migrate()
      }
    }
    const s = new Again()
    stores.push(s)

    s.upgrade()

    expect(s.schemaVersion).toBe(STEP)
    expect(s.copySkipped).toBeNull()
  })
})

describe('a disk short of room', () => {
  it.each([
    { name: 'one byte under twice the store: no copy, and the step still runs', short: 1, copied: false },
    { name: 'exactly twice the store: copied', short: 0, copied: true },
  ])('$name', ({ short, copied }) => {
    const file = storeFile()
    let free = -1
    const os = osWith({ freeBytesSync: () => (free = twice(file) - short) })

    const s = openNext(file, [breaking(STEP)], os)

    expect(s.schemaVersion).toBe(STEP)
    expect(beside(file)).toEqual(copied ? [`store.before-${STEP}.db`] : [])
    expect(s.copySkipped).toEqual(copied ? null : { step: STEP, reason: 'low_disk', free, needed: free + 1 })
    expect(logged().some((line) => line.includes(`no copy before step ${STEP}: the disk has`))).toBe(!copied)
  })

  it('a disk that does not say how much is free is tried', () => {
    const file = storeFile()

    const s = openNext(file, [breaking(STEP)], osWith({ freeBytesSync: () => null }))

    expect(s.copySkipped).toBeNull()
    expect(read(copyOf(file))).toMatchObject({ version: LATEST, projects: ['p1'] })
  })
})

describe('a copy that cannot be written', () => {
  it('leaves no file under any name, keeps the copy from before, and the step still runs', () => {
    const file = storeFile()
    const earlier = copyOf(file, 3)
    files.writeFileSync(earlier, 'the copy before step 3')
    const os = osWith({
      fsyncSync: () => {
        throw new Error('EIO: the disk gave up')
      },
    })

    const s = openNext(file, [breaking(STEP)], os)

    expect(s.schemaVersion).toBe(STEP)
    expect(s.copySkipped).toEqual({ step: STEP, reason: 'failed' })
    expect(beside(file)).toEqual(['store.before-3.db'])
    expect(logged().some((line) => line.includes(`no copy before step ${STEP}: EIO: the disk gave up`))).toBe(true)
  })
})

/*
 * The stop is a real one: a separate process opens the store as the next build and SIGKILLs itself once SQLite has
 * written the copy, before it is renamed or right after, or in its step. Where in the writing it stops does not change
 * what is asked of the first: no file under the copy's name.
 */
type Stop = 'before the rename' | 'after the rename' | 'in the step'
/** More than SQLite holds in memory (16 MB as better-sqlite3 is built), so part of the step is in the WAL before it commits */
const SPILLS = 'CREATE TABLE spilled (x); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO spilled SELECT randomblob(16384) FROM n'
const storeModule = new URL('./store.ts', import.meta.url).href
const osModule = new URL('../os/real.ts', import.meta.url).href
const root = paths.fromFileUrl(new URL('../../../../', import.meta.url))

async function openAndDie(file: string, when: Stop): Promise<void> {
  const inFiles: Record<Stop, string> = {
    'before the rename': 'fsyncSync: die',
    'after the rename': 'renameSync: (from, to) => (real.files.renameSync(from, to), die())',
    'in the step': '',
  }
  const script = join(file, '..', 'die-in-the-copy.mts')
  files.writeFileSync(
    script,
    `const { Store } = await import(${JSON.stringify(storeModule)})
const { realOs } = await import(${JSON.stringify(osModule)})
const real = realOs()
const die = () => {
  real.files.writeSync(1, 'killed ${when}\\n')
  process.kill(process.pid, 'SIGKILL')
}
const os = {
  ...real,
  files: {
    ...real.files,
    ${inFiles[when]}
  },
}
class NextBuild extends Store {
  migrationSteps() {
    return [...super.migrationSteps(), { to: ${STEP}, breaksOlderReaders: true, run: () => { this.db.exec('DELETE FROM projects')${when === 'in the step' ? `; this.db.exec(${JSON.stringify(SPILLS)}); die()` : ''} } }]
  }
}
new NextBuild(${JSON.stringify(file)}, os)
real.files.writeSync(1, 'survived\\n')
`,
  )
  // Not `runSync`: a synchronous wait holds the worker, which answers nothing meanwhile (#368)
  const ran = await processes.run(env.execPath, ['--import', 'tsx', script], { cwd: root, timeoutMs: 60_000 * SLOW })
  expect(ran.stdout.toString()).toBe(`killed ${when}\n`)
}

describe('a host stopped while it writes the copy', () => {
  // A Node with tsx started, and a store opened in it: seconds on a loaded Windows runner
  it('leaves nothing under the copy’s name, and the next open deletes what it left and copies again', { timeout: 60_000 * SLOW }, async () => {
    const file = storeFile()
    await openAndDie(file, 'before the rename')
    // What the stopped host wrote is not a copy. That its step did not run is in the copy the next open makes: of a store still at this build's version
    expect(beside(file)).toEqual(['die-in-the-copy.mts', `store.before-${STEP}.db.partial`])

    const s = openNext(file, [breaking(STEP)])

    expect(s.schemaVersion).toBe(STEP)
    expect(beside(file)).toEqual(['die-in-the-copy.mts', `store.before-${STEP}.db`])
    expect(read(copyOf(file))).toEqual({ version: LATEST, projects: ['p1'], check: 'ok' })
    expect(logged()).toContain(`[store] deleted store.before-${STEP}.db.partial: a host stopped while writing it`)
  })

  // What a real host killed 220 MB into a copy left beside its store: the partial file and SQLite's journal of it
  it('the journal SQLite kept beside the partial file goes with it, also at an open that copies nothing', () => {
    const file = storeFile()
    const left = [`store.before-${STEP}.db.partial`, `store.before-${STEP}.db.partial-journal`]
    for (const name of left) files.writeFileSync(join(file, '..', name), 'half')
    const kept = ['store.db-journal.bak', 'store.before-upgrade.db.partial-journal']
    for (const name of kept) files.writeFileSync(join(file, '..', name), 'not a copy Centralu made')

    openNext(file, [])

    expect(beside(file)).toEqual(kept.sort())
    expect(logged()).toEqual(expect.arrayContaining(left.map((name) => `[store] deleted ${name}: a host stopped while writing it`)))
  })
})

describe('a copy of this step that is there already', () => {
  const KEPT = `[store] store.before-${STEP}.db is kept as the copy before step ${STEP}: an earlier start wrote it, and the store has not changed since`

  // The same real stop, one call later: the copy has its name, and the step has not run
  it('a host stopped between the rename and the step: the next open keeps its copy, held by another program or not, and tells nobody there is none', { timeout: 60_000 * SLOW }, async () => {
    const file = storeFile()
    await openAndDie(file, 'after the rename')
    expect(beside(file)).toEqual(['die-in-the-copy.mts', `store.before-${STEP}.db`])
    // A backup or a scanner reading the copy: Windows refuses a rename over a file held like this
    const holder = realOs().sqlite.open(copyOf(file), { readonly: true })

    try {
      const s = openNext(file, [breaking(STEP)])

      expect(s.schemaVersion).toBe(STEP)
      expect(s.projects.listProjects()).toEqual([])
      expect(s.copySkipped).toBeNull()
    } finally {
      holder.close()
    }
    expect(beside(file)).toEqual(['die-in-the-copy.mts', `store.before-${STEP}.db`])
    expect(read(copyOf(file))).toEqual({ version: LATEST, projects: ['p1'], check: 'ok' })
    expect(logged().some((line) => line.includes('copying the store'))).toBe(false)
    expect(logged()).toContain(KEPT)
  })

  it('a host stopped in its step, part of it in the WAL and none of it committed: the next open keeps its copy', { timeout: 60_000 * SLOW }, async () => {
    const file = storeFile()
    await openAndDie(file, 'in the step')
    // Written after the copy, and not the store: SQLite drops it at the next open
    expect(files.statSync(`${file}-wal`).size).toBeGreaterThan(0)
    expect(files.statSync(`${file}-wal`).mtimeMs).toBeGreaterThan(files.statSync(copyOf(file)).mtimeMs)

    const s = openNext(file, [breaking(STEP)])

    expect(s.schemaVersion).toBe(STEP)
    expect(s.projects.listProjects()).toEqual([])
    expect(s.copySkipped).toBeNull()
    expect(read(copyOf(file))).toEqual({ version: LATEST, projects: ['p1'], check: 'ok' })
    expect(logged().some((line) => line.includes('copying the store'))).toBe(false)
    expect(logged()).toContain(KEPT)
  })

  /**
   * A store with p1 and p2 and, beside it, a file under this step's copy name that holds p1 alone: which projects the
   * copy holds after the open says whether it was kept or written again. Times are whole seconds, which NTFS, APFS
   * and ext4 keep as given.
   */
  function withCopyWrittenAt(seconds: number): string {
    const file = storeFile()
    files.copyFileSync(file, copyOf(file))
    const s = new Store(file)
    s.projects.addProject({ id: 'p2', path: '/tmp/p2', name: 'p2' })
    s.close()
    files.utimesSync(copyOf(file), seconds, seconds)
    return file
  }
  // An hour ago: a copy the open does not yet delete for its age
  const COPIED = Math.floor(Date.now() / 1000) - 3600

  it.each([
    { name: 'the store last written when the copy was: kept', later: 0, kept: true },
    { name: 'the store written a second after the copy: copied again, with what was written since', later: 1, kept: false },
  ])('$name', ({ later, kept }) => {
    const file = withCopyWrittenAt(COPIED)
    files.utimesSync(file, COPIED + later, COPIED + later)
    const synced: string[] = []

    const s = openNext(file, [breaking(STEP)], osWith({ fsyncDirSync: (path) => void synced.push(path) }))

    expect(s.copySkipped).toBeNull()
    expect(read(copyOf(file)).projects).toEqual(kept ? ['p1'] : ['p1', 'p2'])
    // Kept or written, its name reaches the disk: the host that left it may have stopped before that
    expect(synced).toEqual([join(file, '..')])
  })

  it('a commit that is still in the WAL counts as written since', () => {
    const file = withCopyWrittenAt(COPIED)
    files.utimesSync(file, COPIED, COPIED)
    // The build the person went back to, stopped without closing: its commit is in the WAL, and store.db has its old time
    const went = new Store(file)
    stores.push(went)
    went.projects.addProject({ id: 'p3', path: '/tmp/p3', name: 'p3' })
    expect(files.statSync(file).mtimeMs).toBe(COPIED * 1000)

    openNext(file, [breaking(STEP)])

    expect(read(copyOf(file)).projects).toEqual(['p1', 'p2', 'p3'])
  })

  it('a folder under the copy’s name is not a copy: the step runs without one and the person is told', () => {
    const file = storeFile()
    files.mkdirSync(copyOf(file))
    files.utimesSync(copyOf(file), 4_000_000_000, 4_000_000_000)

    const s = openNext(file, [breaking(STEP)])

    expect(s.schemaVersion).toBe(STEP)
    expect(s.copySkipped).toEqual({ step: STEP, reason: 'failed' })
  })
})

describe('the copy’s name reaches the disk', () => {
  it('the store’s folder is synced once the copy has its name', () => {
    const file = storeFile()
    const real = realOs().files
    const did: string[] = []
    const os = osWith({
      renameSync: (from, to) => {
        real.renameSync(from, to)
        did.push(`renamed to ${to}`)
      },
      fsyncDirSync: (path) => void did.push(`synced ${path}`),
    })

    openNext(file, [breaking(STEP)], os)

    expect(did).toEqual([`renamed to ${copyOf(file)}`, `synced ${join(file, '..')}`])
  })

  it('a folder that cannot be synced is said, and the copy is one all the same', () => {
    const file = storeFile()
    const os = osWith({
      fsyncDirSync: () => {
        throw new Error('EINVAL: this disk syncs no folder')
      },
    })

    const s = openNext(file, [breaking(STEP)], os)

    expect(s.copySkipped).toBeNull()
    expect(read(copyOf(file))).toEqual({ version: LATEST, projects: ['p1'], check: 'ok' })
    expect(logged()).toContain(
      `[store] the name of store.before-${STEP}.db could not be synced to the disk, so a power cut now could lose the copy: EINVAL: this disk syncs no folder`,
    )
  })

  it('no copy, nothing to sync', () => {
    const file = storeFile()
    const synced: string[] = []

    openNext(file, [breaking(STEP)], osWith({ freeBytesSync: () => 0, fsyncDirSync: (path) => void synced.push(path) }))

    expect(synced).toEqual([])
  })
})

/** The 14 days the owner decided on #2304, written out here so a change to the constant fails this file */
const COPY_KEPT_MS = 14 * 24 * 60 * 60 * 1000

describe('a copy is kept for 14 days, whatever comes after it', () => {
  /** A store the next build copied and closed, and when the copy was written, by the file's own time */
  function copied(): { file: string; writtenAt: number } {
    const file = storeFile()
    openNext(file, [breaking(STEP)]).close()
    stores.length = 0
    // A whole second: a time every file system keeps as given
    files.utimesSync(copyOf(file), 1_800_000_000, 1_800_000_000)
    return { file, writtenAt: files.statSync(copyOf(file)).mtimeMs }
  }

  it.each([
    { name: 'at 14 days it is still there', past: 0, kept: true },
    { name: 'a millisecond later an open deletes it', past: 1, kept: false },
  ])('$name', ({ past, kept }) => {
    const { file, writtenAt } = copied()

    openNext(file, [breaking(STEP)], osWith({}, () => writtenAt + COPY_KEPT_MS + past))

    expect(files.existsSync(copyOf(file))).toBe(kept)
    expect(logged().includes(`[store] deleted store.before-${STEP}.db: it is older than 14 days`)).toBe(!kept)
  })

  it('the next step’s copy leaves it there, the one the build before can read, and it goes at 14 days of its own', () => {
    const { file, writtenAt } = copied()
    const others = ['store.before-upgrade.db', `store.before-${STEP}.db.bak`, 'store.db.bak', 'host.log']
    for (const name of others) files.writeFileSync(join(file, '..', name), 'not a copy Centralu made')

    openNext(file, [breaking(STEP), breaking(STEP + 1)], osWith({}, () => writtenAt + 1)).close()
    stores.length = 0

    expect(beside(file)).toEqual([...others, `store.before-${STEP}.db`, `store.before-${STEP + 1}.db`].sort())
    expect(read(copyOf(file))).toMatchObject({ version: LATEST, projects: ['p1'] })
    expect(read(copyOf(file, STEP + 1), STEP)).toMatchObject({ version: STEP, projects: [] })

    // Times of their own, a minute apart (the later copy has the real clock's, and reading the two above moved them), then an open a millisecond past the earlier one's 14 days
    files.utimesSync(copyOf(file), 1_800_000_000, 1_800_000_000)
    files.utimesSync(copyOf(file, STEP + 1), 1_800_000_060, 1_800_000_060)
    openNext(file, [breaking(STEP), breaking(STEP + 1)], osWith({}, () => writtenAt + COPY_KEPT_MS + 1))

    expect(beside(file)).toEqual([...others, `store.before-${STEP + 1}.db`].sort())
    expect(logged().includes(`[store] deleted store.before-${STEP}.db: it is older than 14 days`)).toBe(true)
  })
})
