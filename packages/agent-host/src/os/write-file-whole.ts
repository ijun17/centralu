import { randomBytes } from 'node:crypto'
import { sleepSync } from '../timing.js'
import { errnoCode } from './errors.js'
import type { OsFiles } from './port.js'

/**
 * Writes `text` as the whole of `path` through a temp file of its own beside it (`wx`, the mode set at creation), so a reader
 * sees the old file or the new one. The temp file never stays. A rename Windows refuses for a moment (a scanner holds a file) is
 * tried again, up to 300 ms. With `create` the file is linked into place only while there is none; false: another file won.
 */
export function writeFileWhole(files: OsFiles, path: string, text: string, opts: { mode?: number; create?: boolean } = {}): boolean {
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  try {
    files.writeFileSync(tmp, text, { mode: opts.mode, flag: 'wx' })
    if (opts.create) {
      try {
        files.linkSync(tmp, path)
      } catch (e) {
        if (errnoCode(e) === 'EEXIST') return false
        throw e
      }
      return true
    }
    // No O_NOFOLLOW is how the port says Windows
    for (let wait = 20; ; wait *= 2) {
      try {
        files.renameSync(tmp, path)
        return true
      } catch (e) {
        if (files.constants.O_NOFOLLOW !== 0 || wait > 160 || !['EPERM', 'EBUSY', 'EACCES'].includes(errnoCode(e) ?? '')) throw e
        sleepSync(wait)
      }
    }
  } finally {
    try {
      files.rmSync(tmp, { force: true })
    } catch {
      // Held by a scanner: the write's own error is the one to say
    }
  }
}
