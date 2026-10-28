import { afterEach, describe, expect, it } from 'vitest'
import { canSymlink } from '../../link.test-helpers.js'
import { realOs } from '../../os/real.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
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
  it('copies a junction back to its own folder, and a link in a circle, as links, and the rest as it was', () => {
    const root = tempRoot('cc-carry-')
    made.push(root)
    const from = join(root, 'app-data', 'keyA')
    os.files.mkdirSync(join(from, 'sub'), { recursive: true })
    os.files.writeFileSync(join(from, 'sub', 'f'), 'k')
    os.files.symlinkSync(from, join(from, 'sub', 'j'), 'junction')
    if (canSymlink) os.files.symlinkSync('x', join(from, 'x'), 'file')

    carryAppFiles(root, 'keyA', 'keyB')

    const to = join(root, 'app-data', 'keyB')
    expect(os.files.readFileSync(join(to, 'sub', 'f'), 'utf8')).toBe('k')
    expect(os.files.lstatSync(join(to, 'sub', 'j')).isSymbolicLink()).toBe(true)
    expect(os.paths.same(os.files.readlinkSync(join(to, 'sub', 'j')), to)).toBe(true)
    if (canSymlink) expect(os.files.readlinkSync(join(to, 'x'))).toBe('x')
  })

  it("a link into the app's folder leads into the new key's, so what the app writes through it stays with the new key; one outside is kept", () => {
    const root = tempRoot('cc-carry-')
    made.push(root)
    const from = join(root, 'app-data', '_user', 'notes')
    os.files.mkdirSync(join(from, 'sub'), { recursive: true })
    os.files.mkdirSync(join(root, 'shared'))
    os.files.symlinkSync(join(from, 'sub'), join(from, 'subj'), 'junction')
    os.files.symlinkSync(join(root, 'shared'), join(from, 'out'), 'junction')

    carryAppFiles(root, '_user/notes', 'p1/notes')

    const to = join(root, 'app-data', 'p1', 'notes')
    os.files.writeFileSync(join(to, 'subj', 'new'), 'n')
    expect(os.files.readFileSync(join(to, 'sub', 'new'), 'utf8')).toBe('n')
    expect(os.files.existsSync(join(from, 'sub', 'new'))).toBe(false)
    expect(os.paths.same(os.files.readlinkSync(join(to, 'out')), join(root, 'shared'))).toBe(true)
  })
})
