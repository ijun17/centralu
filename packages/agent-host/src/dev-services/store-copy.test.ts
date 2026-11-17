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
import { COPY_KEPT_MS } from './store/store-copy.js'
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
 * written the copy and before it is renamed. Where in the writing it stops does not change what is asked: no file
 * under the copy's name.
 */
describe('a host stopped while it writes the copy', () => {
  const storeModule = new URL('./store.ts', import.meta.url).href
  const osModule = new URL('../os/real.ts', import.meta.url).href
  const root = paths.fromFileUrl(new URL('../../../../', import.meta.url))

  async function openAndDieBeforeTheRename(file: string): Promise<void> {
    const script = join(file, '..', 'die-in-the-copy.mts')
    files.writeFileSync(
      script,
      `const { Store } = await import(${JSON.stringify(storeModule)})
const { realOs } = await import(${JSON.stringify(osModule)})
const real = realOs()
const os = {
  ...real,
  files: {
    ...real.files,
    fsyncSync: () => {
      real.files.writeSync(1, 'killed in the copy\\n')
      process.kill(process.pid, 'SIGKILL')
    },
  },
}
class NextBuild extends Store {
  migrationSteps() {
    return [...super.migrationSteps(), { to: ${STEP}, breaksOlderReaders: true, run: () => this.db.exec('DELETE FROM projects') }]
  }
}
new NextBuild(${JSON.stringify(file)}, os)
real.files.writeSync(1, 'survived\\n')
`,
    )
    // Not `runSync`: a synchronous wait holds the worker, which answers nothing meanwhile (#368)
    const ran = await processes.run(env.execPath, ['--import', 'tsx', script], { cwd: root, timeoutMs: 60_000 * SLOW })
    expect(ran.stdout.toString()).toBe('killed in the copy\n')
  }

  // A Node with tsx started, and a store opened in it: seconds on a loaded Windows runner
  it('leaves nothing under the copy’s name, and the next open deletes what it left and copies again', { timeout: 60_000 * SLOW }, async () => {
    const file = storeFile()
    await openAndDieBeforeTheRename(file)
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

describe('the copy is kept for 14 days and there is one', () => {
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

  it('the next step’s copy replaces it, and no file of another name is touched', () => {
    const { file, writtenAt } = copied()
    const others = ['store.before-upgrade.db', `store.before-${STEP}.db.bak`, 'store.db.bak', 'host.log']
    for (const name of others) files.writeFileSync(join(file, '..', name), 'not a copy Centralu made')

    openNext(file, [breaking(STEP), breaking(STEP + 1)], osWith({}, () => writtenAt + 1))

    expect(beside(file)).toEqual([...others, `store.before-${STEP + 1}.db`].sort())
    expect(read(copyOf(file, STEP + 1), STEP)).toMatchObject({ version: STEP, projects: [] })
  })
})
