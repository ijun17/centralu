import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  baseName,
  copyTree,
  dropEscapingLinks,
  importFile,
  listDir,
  moveEntry,
  prepareCopyTarget,
  readTextFile,
  resolveExisting,
  safeJoin,
} from './fs.js'

/**
 * Checks the side that **changes** files (#18, #19).
 *
 * Missing a path check on a read exposes someone else's file. Missing one on a write **destroys**
 * it — which is why what is here is a safeguard, not a convenience function, and also why it is
 * split out as a pure function that runs with no filesystem at all.
 *
 * Every real filesystem operation happens only inside a temp directory made with `mkdtemp`. Since
 * what this file deals with is deletion and moving, a test must never reach outside of it.
 */

let root = ''
const extraDirs: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-fs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function outsideDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-fs-outside-'))
  extraDirs.push(d)
  return d
}

describe('safeJoin — never leaves the project', () => {
  it('a path inside is joined as-is', () => {
    expect(safeJoin(root, 'src/a.ts')).toBe(join(root, 'src/a.ts'))
  })

  it('an empty path is the root itself (this is what the tree\'s first listing arrives as)', () => {
    expect(safeJoin(root, '')).toBe(root)
  })

  it.each([
    ['../etc/passwd', 'one level up'],
    ['../../etc/passwd', 'two levels up'],
    ['src/../../outside.txt', 'going in and back out'],
    ['/etc/passwd', 'an absolute path'],
  ])('%s is rejected (%s)', (rel) => {
    expect(() => safeJoin(root, rel)).toThrow(/outside the project/)
  })

  /**
   * A sibling directory whose name **merely starts with** the root's is not inside it.
   *
   * Checking only `startsWith(root)` would let `/tmp/cc-fs-12` pass for a project at
   * `/tmp/cc-fs-1`. This is why the separator itself has to be checked too, and it is the most
   * common leak when a path is judged by a string check.
   */
  it('a sibling directory whose name overlaps the root\'s is not inside it', () => {
    const sibling = `${root}-sibling`
    mkdirSync(sibling)
    try {
      expect(() => safeJoin(root, `../${sibling.split('/').pop()}/x.txt`)).toThrow(/outside the project/)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})

describe('baseName — a path cannot pass itself off as a name', () => {
  it('only the last segment survives', () => {
    expect(baseName('src/app/a.ts')).toBe('a.ts')
    expect(baseName('a.ts')).toBe('a.ts')
  })

  it('a name that climbs is not a name', () => {
    expect(() => baseName('..')).toThrow(/Not a file name/)
    expect(() => baseName('')).toThrow(/Not a file name/)
    // Even shaped like `../../x`, in the name slot it becomes `x` — it cannot leave the destination
    expect(baseName('../../x')).toBe('x')
  })

  /**
   * Which characters are separators has two answers, and this asserts the one this machine can
   * see (#47). The wire is POSIX, so `/` is settled by the protocol; `\` is settled by the
   * platform, and here it is an ordinary character in a file name — so a file really called
   * `a\b.txt` keeps its name and can still be moved.
   *
   * The other half cannot be run from here: on Windows `basename` reads that same string as a
   * path, and `baseName` refuses it rather than quietly moving the file to `b.txt`. What is
   * checkable on every platform is the invariant behind both answers — whatever comes back is
   * never something this machine would read as a path.
   */
  it('the separator decision is left to the platform — here `\\` is part of the name', () => {
    expect(baseName('src/a\\b.txt')).toBe('a\\b.txt')
    for (const input of ['src/app/a.ts', 'a\\b.txt', '../../.ssh/authorized_keys', 'x.md']) {
      let name: string
      try {
        name = baseName(input)
      } catch {
        continue // rejection is a correct answer too (the second one is, on Windows)
      }
      expect(name).not.toContain(sep)
    }
  })
})

describe('listDir — a project that is not a repository', () => {
  /**
   * A project does not have to be a git repository — the first-run screen says so in as many
   * words.
   *
   * When it is not one, `git check-ignore` reads nothing and dies immediately, and the list we
   * were writing lands on a closed pipe (EPIPE). The answer itself has no problem (nothing is
   * ignored). The problem is that if nobody is listening for that EPIPE, **the whole host process
   * dies** — taking every session inside it down with it.
   *
   * This only reproduces reliably once the list exceeds the pipe buffer (measured at 65,536
   * bytes). Below that, our write finishes before git is gone and just goes through, which is how
   * this bug survived for weeks. Two Linux runners in CI hit it at a much smaller size, on timing
   * alone.
   */
  it('the list comes back even with many files — the host survives even if git dies first', async () => {
    const long = 'n'.repeat(200)
    const names = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(4, '0')}-${long}.txt`)
    // 400 x 206 bytes ~= 82KB — reliably exceeds the buffer
    expect(names.join('\n').length).toBeGreaterThan(65_536)
    for (const n of names) writeFileSync(join(root, n), '')

    const entries = await listDir(root, '')
    expect(entries).toHaveLength(names.length)
    // Not a repository, so nothing is ignored either — painting everything as ignored just because it could not be asked would leave the tree empty
    expect(entries.every((e) => !e.ignored)).toBe(true)
  })
})

describe('listDir — the ignore decision for a Korean name (#176)', () => {
  /**
   * `check-ignore`'s line-based output wraps a Korean name as `"\355\254\264…"`. Matching the
   * line received against the name only disagreed for Korean files, so an ignored Korean file was
   * never shown dimmed.
   */
  it('an ignored Korean file is shown as ignored too', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), '무시됨.log\nascii.log\n')
    for (const n of ['무시됨.log', 'ascii.log', '한글파일.md']) writeFileSync(join(root, n), '')

    const ignored = Object.fromEntries((await listDir(root, '')).map((e) => [e.name.normalize('NFC'), e.ignored]))
    expect(ignored).toMatchObject({ '무시됨.log': true, 'ascii.log': true, '한글파일.md': false })
  })
})

describe('copyTree — the ordinary copy after a clone stops partway (#167)', () => {
  /**
   * `cp -Rc` already creates part of the result before it fails. Running an ordinary copy on top
   * of that died trying to overwrite a directory symlink that had already come across, so the
   * fallback path failed to actually fall back.
   */
  it('deletes the half-finished result and copies again from scratch', async () => {
    const src = join(root, 'src')
    mkdirSync(join(src, 'pkg'), { recursive: true })
    writeFileSync(join(src, 'pkg', 'index.js'), 'module.exports = 1\n')
    symlinkSync('pkg', join(src, 'alias'))
    const dst = join(root, 'dst')
    // The shape of a clone that created the link and folder, then failed
    const halfClone = async () => {
      mkdirSync(join(dst, 'pkg'), { recursive: true })
      symlinkSync('pkg', join(dst, 'alias'))
      return false
    }

    await copyTree(src, dst, halfClone)
    expect(readFileSync(join(dst, 'alias', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(lstatSync(join(dst, 'alias')).isSymbolicLink()).toBe(true)
  })
})

describe('readTextFile — image previews', () => {
  it('a supported raster image is returned as MIME and base64, not text', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    writeFileSync(join(root, 'logo.png'), bytes)

    await expect(readTextFile(root, 'logo.png')).resolves.toEqual({
      text: '',
      truncated: false,
      binary: true,
      bytes: 4,
      image: { mime: 'image/png', data: bytes.toString('base64') },
    })
  })

  it('SVG returns both an image preview and a text read', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
    writeFileSync(join(root, 'logo.svg'), svg)

    await expect(readTextFile(root, 'logo.svg')).resolves.toEqual({
      text: svg,
      truncated: false,
      binary: false,
      bytes: Buffer.byteLength(svg),
      image: { mime: 'image/svg+xml', data: Buffer.from(svg).toString('base64') },
    })
  })

  it('an image over the cap sends no bytes and says why', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'large.png'), Buffer.alloc(10_000_001))

    await expect(readTextFile(root, 'large.png')).resolves.toMatchObject({
      text: '',
      binary: true,
      bytes: 10_000_001,
      previewError: expect.stringMatching(/too large/i),
    })
  })
})

describe('a symlink is only resolved within the project root', () => {
  it('Given a link in the middle of the path points outside When the listing is opened Then it is rejected as outside the project', async () => {
    const outside = outsideDir()
    mkdirSync(join(outside, 'nested'))
    writeFileSync(join(outside, 'nested', 'secret.txt'), 'leak')
    symlinkSync(outside, join(root, 'linked'), 'dir')

    await expect(listDir(root, 'linked/nested')).rejects.toThrow(/outside the project/i)
  })

  it('Given a link at the end of the path points to a file outside When a shell path is created Then it is rejected as outside the project', async () => {
    const outside = outsideDir()
    writeFileSync(join(outside, 'secret.txt'), 'leak')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'secret.txt'))

    await expect(resolveExisting(root, 'secret.txt')).rejects.toThrow(/outside the project/i)
  })

  it('Given the item to move is a link pointing outside When it is moved Then the outside file is never moved', async () => {
    const outside = outsideDir()
    writeFileSync(join(outside, 'secret.txt'), 'leak')
    mkdirSync(join(root, 'dst'))
    symlinkSync(join(outside, 'secret.txt'), join(root, 'secret.txt'))

    await expect(moveEntry(root, 'secret.txt', 'dst')).rejects.toThrow(/outside the project/i)
  })

  it('Given the destination folder is a link pointing outside When moving Then nothing is written outside', async () => {
    const outside = outsideDir()
    writeFileSync(join(root, 'a.ts'), 'inside')
    symlinkSync(outside, join(root, 'drop'), 'dir')

    await expect(moveEntry(root, 'a.ts', 'drop')).rejects.toThrow(/outside the project/i)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('inside')
  })

  it('Given the import destination folder is a link When a file is written Then it is not created outside the link', async () => {
    const outside = outsideDir()
    symlinkSync(outside, join(root, 'drop'), 'dir')

    await expect(importFile(root, 'drop', 'a.ts', Buffer.from('inside'))).rejects.toThrow(/outside the project/i)
  })

  it('Given the file to read is a link When text is opened Then the link target is never read', async () => {
    const outside = outsideDir()
    writeFileSync(join(outside, 'secret.txt'), 'leak')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'secret.txt'))

    await expect(readTextFile(root, 'secret.txt')).rejects.toThrow(/outside the project/i)
  })

  it('Given a broken link When a shell path is created Then it is rejected as a missing file', async () => {
    symlinkSync(join(root, 'missing.txt'), join(root, 'dangling.txt'))

    await expect(resolveExisting(root, 'dangling.txt')).rejects.toThrow(/no longer there/i)
  })

  it('Given the link points inside the project When a file is read Then it is allowed like an ordinary file', async () => {
    mkdirSync(join(root, 'actual'))
    writeFileSync(join(root, 'actual', 'inside.txt'), 'inside')
    symlinkSync(join(root, 'actual'), join(root, 'linked'), 'dir')

    await expect(readTextFile(root, 'linked/inside.txt')).resolves.toMatchObject({ text: 'inside', binary: false })
  })

  it('Given the link points inside the project When the listing is opened Then a pnpm-style internal link is followed too', async () => {
    mkdirSync(join(root, 'store/pkg'), { recursive: true })
    writeFileSync(join(root, 'store/pkg', 'index.js'), 'export {}')
    mkdirSync(join(root, 'node_modules'))
    symlinkSync(join(root, 'store/pkg'), join(root, 'node_modules/pkg'), 'dir')

    await expect(listDir(root, 'node_modules/pkg')).resolves.toEqual([
      { name: 'index.js', path: 'node_modules/pkg/index.js', isDir: false, ignored: false },
    ])
  })

})

describe('moveEntry', () => {
  it('moves a file into a folder', async () => {
    writeFileSync(join(root, 'a.ts'), 'hello')
    mkdirSync(join(root, 'src'))
    const res = await moveEntry(root, 'a.ts', 'src')
    expect(res).toEqual({ path: 'src/a.ts', moved: true })
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('hello')
    expect((await listDir(root, '')).map((e) => e.name)).toEqual(['src'])
  })

  it('a folder moves along with everything inside it', async () => {
    mkdirSync(join(root, 'pkg/sub'), { recursive: true })
    mkdirSync(join(root, 'dest'))
    writeFileSync(join(root, 'pkg/sub/deep.ts'), 'x')
    await moveEntry(root, 'pkg', 'dest')
    expect(readFileSync(join(root, 'dest/pkg/sub/deep.ts'), 'utf8')).toBe('x')
  })

  /**
   * **There is no overwrite.** This side has no way to know whether a file already there is one
   * an agent is currently editing, and silently replacing it is the one outcome with no way back.
   */
  it('when the spot is taken, nothing moves and it says what it collided with', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'a.ts'), 'new')
    writeFileSync(join(root, 'src/a.ts'), 'old')
    await expect(moveEntry(root, 'a.ts', 'src')).rejects.toThrow('src/a.ts already exists')
    // Both the source and the destination have to remain untouched — a half-moved state is the worst outcome
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('old')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('new')
  })

  it('putting it where it already is is not a failure, but moved:false', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/a.ts'), 'x')
    expect(await moveEntry(root, 'src/a.ts', 'src')).toEqual({ path: 'src/a.ts', moved: false })
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('x')
  })

  it('a folder cannot be moved into itself', async () => {
    mkdirSync(join(root, 'pkg/sub'), { recursive: true })
    await expect(moveEntry(root, 'pkg', 'pkg/sub')).rejects.toThrow(/into itself/)
  })

  it('rejects when the source is outside the project', async () => {
    await expect(moveEntry(root, '../outside.txt', '')).rejects.toThrow(/outside the project/)
  })

  it('rejects when the destination is outside the project', async () => {
    writeFileSync(join(root, 'a.ts'), 'x')
    await expect(moveEntry(root, 'a.ts', '../..')).rejects.toThrow(/outside the project/)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('x')
  })

  it('the project itself cannot be moved', async () => {
    mkdirSync(join(root, 'sub'))
    await expect(moveEntry(root, '', 'sub')).rejects.toThrow(/Cannot move the project itself/)
  })
})

describe('importFile — a file dragged in from outside', () => {
  it('writes into the folder and returns the new path', async () => {
    mkdirSync(join(root, 'assets'))
    const res = await importFile(root, 'assets', 'shot.png', Buffer.from('bytes'))
    expect(res).toEqual({ path: 'assets/shot.png' })
    expect(readFileSync(join(root, 'assets/shot.png'), 'utf8')).toBe('bytes')
  })

  it('cannot leave the destination even when a path is mixed into the name', async () => {
    mkdirSync(join(root, 'assets'))
    const res = await importFile(root, 'assets', '../../evil.txt', Buffer.from('x'))
    expect(res.path).toBe('assets/evil.txt')
  })

  it('does not overwrite when the same name already exists', async () => {
    writeFileSync(join(root, 'shot.png'), 'original')
    await expect(importFile(root, '', 'shot.png', Buffer.from('new'))).rejects.toThrow(/already exists/)
    expect(readFileSync(join(root, 'shot.png'), 'utf8')).toBe('original')
  })

  it('rejects when the destination is not a folder', async () => {
    writeFileSync(join(root, 'a.ts'), 'x')
    await expect(importFile(root, 'a.ts', 'b.ts', Buffer.from('y'))).rejects.toThrow(/not a folder/)
  })

  it('rejects when the destination is outside the project', async () => {
    await expect(importFile(root, '..', 'evil.txt', Buffer.from('x'))).rejects.toThrow(/outside the project/)
  })
})

describe('resolveExisting — the absolute path handed to the shell', () => {
  it('gives the absolute path of a file that exists', async () => {
    writeFileSync(join(root, 'a.ts'), 'x')
    expect(await resolveExisting(root, 'a.ts')).toBe(realpathSync(join(root, 'a.ts')))
  })

  /** Handing the shell a path that does not exist does nothing at all — this blocks that silence */
  it('rejects a file that does not exist', async () => {
    await expect(resolveExisting(root, 'gone.ts')).rejects.toThrow(/no longer there/)
  })

  it('rejects outside the project (so the trash never swallows someone else\'s file)', async () => {
    await expect(resolveExisting(root, '../..')).rejects.toThrow(/outside the project/)
  })
})

/**
 * **The string that is checked has to be the string that is used** (#119).
 *
 * The guard walked with `..` left as a segment, following symlinks and then climbing back up to
 * a parent. The path the actual syscall uses is instead built by `safeJoin` folding it first with
 * `resolve()`. When a link's target sits deeper than the link itself, the two disagree: the guard
 * looks inside and allows it, while what actually opens is outside.
 *
 * All four operations are checked, because it is not just reading that leaked — **writing and
 * watching leaked too.**
 */
describe('a .. past a symlink cannot split the guard from the syscall (#119)', () => {
  let outside = ''

  beforeEach(() => {
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'cc-outside-')))
    extraDirs.push(outside)
    writeFileSync(join(outside, 'SECRET.txt'), 'outside')
    // The link's target sits deeper than the link itself — this difference is what split the two paths
    mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
    // The bait the guard will end up walking. Its name has to match the outside link's
    mkdirSync(join(root, 'sub', 'evil'))
    symlinkSync(join(root, 'sub', 'deep'), join(root, 'link'))
    symlinkSync(outside, join(root, 'evil'))
  })

  it('cannot be listed', async () => {
    await expect(listDir(root, 'link/../evil')).rejects.toThrow(/outside the project/i)
  })

  it('cannot be read', async () => {
    await expect(readTextFile(root, 'link/../evil/SECRET.txt')).rejects.toThrow(/outside the project/i)
  })

  it('cannot be created inside it', async () => {
    await expect(importFile(root, 'link/../evil', 'planted.txt', Buffer.from('x'))).rejects.toThrow(
      /outside the project/i,
    )
  })

  it('a project file cannot be moved there', async () => {
    writeFileSync(join(root, 'mine.txt'), 'mine')
    await expect(moveEntry(root, 'mine.txt', 'link/../evil')).rejects.toThrow(/outside the project/i)
    expect(readFileSync(join(root, 'mine.txt'), 'utf8')).toBe('mine')
  })

  it('a path leaving the root is still blocked even after folding', async () => {
    await expect(listDir(root, '../')).rejects.toThrow(/outside the project/i)
    await expect(listDir(root, 'sub/../../')).rejects.toThrow(/outside the project/i)
  })

  it('a .. that stays inside still works as usual', async () => {
    writeFileSync(join(root, 'a.txt'), 'inside')
    await expect(readTextFile(root, 'sub/../a.txt')).resolves.toBeTruthy()
  })
})

/**
 * #95: links left behind once worktree provisioning finishes copying.
 *
 * There is one boundary decided here — **pointing outside is a window, pointing inside is just a
 * link.**
 */
describe('links left in a copied tree', () => {
  it('a broken link is judged by the text it points to too — becoming a window the moment its target comes to exist', async () => {
    const outside = outsideDir()
    symlinkSync(join(outside, 'not-yet'), join(root, 'later'))
    symlinkSync('also-not-yet', join(root, 'inside-later'))

    expect(await dropEscapingLinks(root, root)).toEqual(['later'])
    expect(() => lstatSync(join(root, 'later'))).toThrow()
    // A broken link pointing inside is left as-is — its target may still come to exist inside this tree
    expect(lstatSync(join(root, 'inside-later')).isSymbolicLink()).toBe(true)
  })

  it('never walks into a link — never gets caught in a cycle', async () => {
    mkdirSync(join(root, 'a'))
    symlinkSync(join(root, 'a'), join(root, 'a', 'self'))

    await expect(dropEscapingLinks(root, root)).resolves.toEqual([])
  })

  it('creates nothing and writes nothing when the destination\'s parent is a link', async () => {
    const outside = outsideDir()
    symlinkSync(outside, join(root, 'out'))

    await expect(prepareCopyTarget(root, 'out/app.env')).rejects.toThrow(/outside the project/i)
    expect(existsSync(join(outside, 'app.env'))).toBe(false)
  })

  it('creates a missing parent — writing `sub/.env` in a list is an ordinary thing to do', async () => {
    const dst = await prepareCopyTarget(root, 'sub/deeper/.env')

    expect(dst).toBe(join(root, 'sub', 'deeper', '.env'))
    expect(existsSync(join(root, 'sub', 'deeper'))).toBe(true)
  })
})
