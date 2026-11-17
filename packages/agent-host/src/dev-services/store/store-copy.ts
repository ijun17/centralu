import type Database from 'better-sqlite3'
import { errorMessage } from '@cc/protocol'
import { bytesText } from '../../bytes-text.js'
import { isObj } from '../../json-value.js'
import type { Os } from '../../os/port.js'

/**
 * How long a copy is kept (#2304, the owner's decision): long enough to notice what an update broke and go back, short
 * enough that a file the size of the store does not stay for good.
 */
export const COPY_KEPT_MS = 14 * 24 * 60 * 60 * 1000

/** The free space a copy is made with, in store sizes: the copy itself and as much again for the store to keep working */
const FREE_STORE_SIZES = 2

/** What a copy is written under until it is whole */
const PARTIAL = '.partial'
/**
 * What a copy that was not finished leaves: the partial file, and the journal SQLite keeps beside the file it is
 * writing. A host killed in `VACUUM INTO` leaves both (seen with a real host stopped 220 MB into a copy).
 */
const UNFINISHED = new RegExp(`\\${PARTIAL}(-journal)?$`)

/**
 * A step that breaks older readers ran without a copy (#2304), and why: the disk had less than the copy is made with
 * (`free` of the `needed` bytes), or writing it failed. The person is told (mail/host-mail.ts `afterReady`).
 */
export type CopySkipped = { step: number; reason: 'low_disk'; free: number; needed: number } | { step: number; reason: 'failed' }

/**
 * The copy of the store kept before a step that breaks older readers (#2304): a step is the one change a person cannot
 * undo by installing the build they had, so the store as it was stays beside it, `store.before-<step>.db` next to
 * `store.db`, with the store's permissions. Each copy stays for 14 days and leaves by its age alone: a later copy
 * does not delete it, because the earlier one may be the only one from before an update's first breaking step.
 * Nothing reads a copy: getting it back is the person's own step
 * (docs/agent-host/store-migrations.md "Getting the copy back"). The runner says when (store/migrate-runner.ts).
 *
 * A file under a copy's name is always a whole copy: it is written as `.partial`, reaches the disk, and is renamed
 * only then, so a host stopped while writing leaves a `.partial` (and SQLite's journal of it) the next open deletes.
 * One stopped after the rename and before its step committed leaves the copy itself, which the next open keeps.
 */
export class StoreCopies {
  private readonly dir: string
  /** `store.before-` for `store.db`: what every copy's name starts with */
  private readonly prefix: string

  constructor(
    private readonly os: Os,
    private readonly db: Database.Database,
    private readonly dbPath: string,
  ) {
    const { path } = os.paths
    this.dir = path.dirname(dbPath)
    this.prefix = `${path.basename(dbPath, path.extname(dbPath))}.before-`
  }

  /** Every open: what a stopped host left half written goes, and so does a copy older than 14 days */
  sweep(): void {
    const now = this.os.clock.now()
    for (const name of this.names()) {
      if (UNFINISHED.test(name)) {
        this.remove(name, 'a host stopped while writing it')
        continue
      }
      if (now - this.writtenAt(name) > COPY_KEPT_MS) this.remove(name, 'it is older than 14 days')
    }
  }

  /** When the copy was written, by the file's own time; now for one that cannot be read, which is left */
  private writtenAt(name: string): number {
    try {
      return this.os.files.statSync(this.at(name)).mtimeMs
    } catch {
      return this.os.clock.now()
    }
  }

  /**
   * Keeps the store as it is now, before `step` runs. Called outside a transaction (`VACUUM` refuses one) and under
   * the host's lock, so no other writer runs: `VACUUM INTO` reads one snapshot, the WAL's commits included.
   *
   * A copy that cannot be made never keeps the host from starting: the step runs without one, and what is returned
   * says so.
   */
  copyBefore(step: number): CopySkipped | null {
    const name = `${this.prefix}${step}.db`
    if (this.holdsTheStoreAsItIs(name)) {
      console.error(`[store] ${name} is kept as the copy before step ${step}: an earlier start wrote it, and the store has not changed since`)
    } else {
      const skipped = this.write(name, step)
      if (skipped) return skipped
    }
    try {
      /*
       * A rename is in the folder, not in the file: without this a power cut could undo it while the step's commit
       * stays, and the next open would delete a whole `.partial`. For a kept copy too: the host that renamed it may
       * have stopped before this.
       */
      this.os.files.fsyncDirSync(this.dir)
    } catch (err) {
      // The copy is whole and under its name, so this is not a step without a copy
      console.error(`[store] the name of ${name} could not be synced to the disk, so a power cut now could lose the copy: ${errorMessage(err)}`)
    }
    return null
  }

  /**
   * Whether this step's copy is there already and nothing was committed to the store since: a host wrote it and its
   * step did not commit (the store is still below the step), stopped before the step, in it, or by the step's own
   * error. It is the copy then, and writing it again would only add a rename over it that can be refused (Windows,
   * while a backup or a scanner holds the file), with a notice that says there is no copy beside a whole one, and
   * the copy's time again at every start of a host that stops in a long step.
   *
   * By the files' own times, the WAL's included, since a commit reaches the WAL first. A WAL written after the copy
   * counts only for the commits in it: an open makes an empty one new, and a step stopped before its commit leaves the
   * part that outgrew SQLite's memory, which SQLite drops. A store written since is copied again: its step failed and
   * the person went on with the build they had, and the earlier copy lacks that work. A time that wrongly reads as
   * written since costs one more copy; one that wrongly reads as not (a clock set back, a store put back from a backup
   * with its old time) keeps a copy without the work since.
   */
  private holdsTheStoreAsItIs(name: string): boolean {
    const stat = (path: string) => this.os.files.statSync(path, { throwIfNoEntry: false })
    try {
      const copy = stat(this.at(name))
      if (!copy?.isFile() || (stat(this.dbPath)?.mtimeMs ?? Infinity) > copy.mtimeMs) return false
      const wal = stat(`${this.dbPath}-wal`)
      return !wal?.size || wal.mtimeMs <= copy.mtimeMs || !this.walHoldsCommits()
    } catch {
      // What cannot be read is not kept: the copy is written, and what fails there is said
      return false
    }
  }

  /**
   * Whether the WAL holds a commit, copied back to the store or not. Asked with a checkpoint that waits for nobody,
   * which says it without reading the WAL's frames here: what it copies back is in the store either way.
   */
  private walHoldsCommits(): boolean {
    const answer: unknown = this.db.pragma('wal_checkpoint(PASSIVE)')
    const row: unknown = Array.isArray(answer) ? answer[0] : undefined
    return !(isObj(row) && row.log === 0)
  }

  /** Writes the copy `name` from the store's own connection, or says why not, with nothing unfinished left behind */
  private write(name: string, step: number): CopySkipped | null {
    const { files, clock } = this.os
    const partial = this.at(name + PARTIAL)
    const t0 = clock.now()
    try {
      const store = files.statSync(this.dbPath)
      const size = store.size + (files.statSync(`${this.dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0)
      const needed = FREE_STORE_SIZES * size
      // A disk that does not say how much is free is tried: a copy that does not fit fails below and is cleaned up
      const free = files.freeBytesSync(this.dir)
      if (free !== null && free < needed) {
        console.error(
          `[store] no copy before step ${step}: the disk has ${bytesText(free)} free and the copy is made with ${bytesText(needed)} (twice the store); the step runs without one`,
        )
        return { step, reason: 'low_disk', free, needed }
      }
      console.error(`[store] copying the store (${bytesText(size)}) to ${this.at(name)} before step ${step}, which an older Centralu cannot read past`)
      /*
       * Made here, empty, with the store's own permissions, and filled by SQLite, which would make it as wide as the
       * umask allows. Where modes guard nothing (Windows) the file takes the data folder's access list, as the store did.
       */
      const mode = store.mode & 0o777
      const made = files.openSync(partial, 'wx', mode)
      try {
        if (this.os.traits.modesGuardFiles) files.fchmodSync(made, mode)
      } finally {
        files.closeSync(made)
      }
      this.db.prepare('VACUUM INTO ?').run(partial)
      // SQLite does not sync what `VACUUM INTO` wrote: without this a power cut after the rename could leave a whole name on half a file
      const written = files.openSync(partial, 'r+')
      try {
        files.fsyncSync(written)
      } finally {
        files.closeSync(written)
      }
      files.renameSync(partial, this.at(name))
    } catch (err) {
      console.error(`[store] no copy before step ${step}: ${errorMessage(err)}; the step runs without one`)
      // The open swept what earlier hosts left, so what is unfinished now is this copy's
      for (const left of this.names()) if (UNFINISHED.test(left)) this.remove(left, 'the copy failed')
      return { step, reason: 'failed' }
    }
    console.error(`[store] copied in ${clock.now() - t0}ms; the copy is deleted after 14 days`)
    return null
  }

  private at(name: string): string {
    return this.os.paths.path.join(this.dir, name)
  }

  /** The copies beside the store, whole and unfinished: `<prefix><step>.db` with a step number and nothing else */
  private names(): string[] {
    try {
      return this.os.files.readdirSync(this.dir).filter((name) => {
        const whole = name.replace(UNFINISHED, '')
        return whole.startsWith(this.prefix) && /^\d+\.db$/.test(whole.slice(this.prefix.length))
      })
    } catch (err) {
      console.error(`[store] could not look for copies of the store in ${this.dir}: ${errorMessage(err)}`)
      return []
    }
  }

  /** A copy that cannot be deleted is said and left: the next open tries again */
  private remove(name: string, why: string): void {
    try {
      if (!this.os.files.existsSync(this.at(name))) return
      this.os.files.rmSync(this.at(name), { force: true })
      console.error(`[store] deleted ${name}: ${why}`)
    } catch (err) {
      console.error(`[store] could not delete ${name} (${why}): ${errorMessage(err)}`)
    }
  }
}
