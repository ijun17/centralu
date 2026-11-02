import { afterEach, describe, expect, it } from 'vitest'
import { canSymlink } from '../../link.test-helpers.js'
import { realOs } from '../../os/real.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { copyTreeAsync } from '../../os/copy.js'
import { HOST_FAMILY } from '../../os/real.js'
import type { Os } from '../../os/port.js'
import { carryAppFiles } from './carry.js'

/**
 * An app's data carried to its new key (#1650 review): an app writes its own data folder, so whatever links it left
 * there are copied, by the `Os`'s copy, as links. Node's own `cpSync` ended the host over a junction back to the folder
 * (Windows, 0xC0000409) and over a link in a circle. A link into the folder leads into the new key's: kept as written,
 * a junction (always a whole path) tied the new key's data to the old key's folder.
 */
const os = realOs()
const { join } = os.paths.path
const made: string[] = []
afterEach(async () => {
  await Promise.all(made.splice(0).map(removeTree))
})

describe('carrying an app to a new key', () => {
  it('copies a junction back to its own folder, and a link in a circle, as links, and the rest as it was', async () => {
    const root = tempRoot('cc-carry-')
    made.push(root)
    const from = join(root, 'app-data', 'keyA')
    os.files.mkdirSync(join(from, 'sub'), { recursive: true })
    os.files.writeFileSync(join(from, 'sub', 'f'), 'k')
    os.files.symlinkSync(from, join(from, 'sub', 'j'), 'junction')
    if (canSymlink) os.files.symlinkSync('x', join(from, 'x'), 'file')

    await carryAppFiles(root, 'keyA', 'keyB')

    const to = join(root, 'app-data', 'keyB')
    expect(os.files.readFileSync(join(to, 'sub', 'f'), 'utf8')).toBe('k')
    expect(os.files.lstatSync(join(to, 'sub', 'j')).isSymbolicLink()).toBe(true)
    expect(os.paths.same(os.files.readlinkSync(join(to, 'sub', 'j')), to)).toBe(true)
    if (canSymlink) expect(os.files.readlinkSync(join(to, 'x'))).toBe('x')
  })

  it("a link into the app's folder leads into the new key's, so what the app writes through it stays with the new key; one outside is kept", async () => {
    const root = tempRoot('cc-carry-')
    made.push(root)
    const from = join(root, 'app-data', '_user', 'notes')
    os.files.mkdirSync(join(from, 'sub'), { recursive: true })
    os.files.mkdirSync(join(root, 'shared'))
    os.files.symlinkSync(join(from, 'sub'), join(from, 'subj'), 'junction')
    os.files.symlinkSync(join(root, 'shared'), join(from, 'out'), 'junction')

    await carryAppFiles(root, '_user/notes', 'p1/notes')

    const to = join(root, 'app-data', 'p1', 'notes')
    os.files.writeFileSync(join(to, 'subj', 'new'), 'n')
    expect(os.files.readFileSync(join(to, 'sub', 'new'), 'utf8')).toBe('n')
    expect(os.files.existsSync(join(from, 'sub', 'new'))).toBe(false)
    expect(os.paths.same(os.files.readlinkSync(join(to, 'out')), join(root, 'shared'))).toBe(true)
  })

  /*
   * #1707: an app's data may hold a link into a share that does not answer; Windows waits about 21 s for the first stat of
   * one, and the synchronous copy held the host's event loop that long (measured: 21.1 s without a tick). The copy is a
   * promise copy now, and a step that does not answer in time fails the carry. Here an `Os` whose files never answer.
   */
  describe('when the files do not answer (a link into a share that is not there)', () => {
    const never = () => new Promise<never>(() => {})
    // Answers every step but the one for a file of the app's data, so the copy beside its place is made before it stalls
    let mkdirs = 0
    const stalling = (root: string): Os => {
      const files = {
        ...os.files.promises,
        mkdir: (...a: Parameters<typeof os.files.promises.mkdir>) => (mkdirs++, os.files.promises.mkdir(...a)),
        lstat: (p: string) => (p === join(root, 'app-data', 'keyA', 'f') ? never() : os.files.promises.lstat(p)),
      }
      return { ...os, files: { ...os.files, promises: { ...os.files.promises, cp: (a, b, o) => copyTreeAsync(files, a, b, o, HOST_FAMILY, os.paths.path) } } }
    }

    it('keeps the host serving meanwhile, and fails within the bound with the step named and nothing left beside the place', async () => {
      const root = tempRoot('cc-carry-')
      made.push(root)
      os.files.mkdirSync(join(root, 'app-data', 'keyA'), { recursive: true })
      os.files.writeFileSync(join(root, 'app-data', 'keyA', 'f'), 'k')
      let ticks = 0
      const timer = setInterval(() => ticks++, 10)
      const t0 = Date.now()
      try {
        await expect(carryAppFiles(root, 'keyA', 'keyB', { os: stalling(root), stepMs: 200 })).rejects.toMatchObject({ code: 'ETIMEDOUT', message: expect.stringContaining('did not answer within 200 ms') })
      } finally {
        clearInterval(timer)
      }
      expect(Date.now() - t0).toBeLessThan(5000)
      expect(ticks).toBeGreaterThan(5)
      // The copy beside its place was started, and is gone
      expect(mkdirs).toBeGreaterThan(0)
      expect(os.files.readdirSync(join(root, 'app-data'))).toEqual(['keyA'])
    })
  })
})
