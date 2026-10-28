import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { forAll, name, recase, sameOnNtfs, type Rng } from './property.test-helpers.js'
import {
  envValue,
  fileUrlToPath,
  findOnPath,
  foldCase,
  isInside,
  linkLoop,
  pathKey,
  pathRules,
  pathRulesFrom,
  pathToFileUrl,
  programCandidates,
  samePath,
  signalRefusal,
  systemTool,
  traitsOf,
  type OsFamily,
  type TreeReader,
} from './rules.js'

/**
 * The OS family's rules (#1599, docs/plans/os-layer.md §7.1), for both families on whatever OS this runs: paths and their
 * case, PATH lookup, the environment's case. Properties over generated paths and names; `real.test.ts` holds what Node
 * itself answers to the same rules on the real OS.
 */

const FAMILIES: OsFamily[] = ['windows', 'posix']

/** An absolute path of the family: a drive or `/`, and some names */
function absolute(r: Rng, family: OsFamily, depth = r.int(0, 5)): string {
  const names = Array.from({ length: depth }, () => name(r))
  return family === 'windows' ? win32.join(`${r.pick(['C', 'c', 'D'])}:\\`, ...names) : posix.join('/', ...names)
}

/** The same path written another way the family reads as the same: `/` for `\`, a trailing separator, `.` segments */
function respelled(r: Rng, p: string, family: OsFamily): string {
  let s = p
  if (family === 'windows') s = [...s].map((c) => (c === '\\' && r.bool() ? '/' : c)).join('')
  if (r.bool()) s += family === 'windows' ? r.pick(['\\', '/']) : '/'
  if (r.bool(0.3)) s = pathRules(family).join(s, '.')
  return s
}

describe('paths by the family’s rules', () => {
  for (const family of FAMILIES) {
    it(`${family}: a path is the same path however its separators, trailing separator and dots are written`, () => {
      forAll(
        (r) => {
          const p = absolute(r, family)
          return { p, q: respelled(r, p, family) }
        },
        ({ p, q }) => {
          expect(samePath(p, q, family)).toBe(true)
          expect(pathKey(p, family)).toBe(pathKey(q, family))
        },
      )
    })

    it(`${family}: another case is the same path only on Windows`, () => {
      forAll(
        (r) => {
          const p = absolute(r, family, r.int(1, 5))
          return { p, q: recase(r, p) }
        },
        ({ p, q }) => expect(samePath(p, q, family)).toBe(family === 'windows' || p === q),
      )
    })

    it(`${family}: inside by segment: a path under the root is inside, a sibling that only starts the same is not`, () => {
      forAll(
        (r) => {
          const root = absolute(r, family, r.int(1, 4))
          const below = Array.from({ length: r.int(0, 4) }, () => name(r))
          return { root, child: pathRules(family).join(root, ...below), sibling: `${root}${r.pick(['-old', 'x', '.bak', ' 2'])}`, below: below.length }
        },
        ({ root, child, sibling, below }) => {
          expect(isInside(root, child, family)).toBe(true)
          expect(isInside(root, sibling, family)).toBe(false)
          // Not inside what is inside it, unless it is the same
          expect(isInside(child, root, family)).toBe(below === 0)
        },
      )
    })

    it(`${family}: inside ignores case on Windows only`, () => {
      forAll(
        (r) => {
          const root = absolute(r, family, r.int(1, 4))
          return { root, child: pathRules(family).join(recase(r, root), name(r)) }
        },
        ({ root, child }) => {
          const sameCase = pathRules(family).dirname(child) === root
          expect(isInside(root, child, family)).toBe(family === 'windows' || sameCase)
        },
      )
    })

    it(`${family}: a path's file URL leads back to the path`, () => {
      forAll(
        (r) => absolute(r, family, r.int(0, 5)),
        (p) => expect(fileUrlToPath(pathToFileUrl(p, family), family)).toBe(pathRules(family).resolve(p)),
      )
    })
  }

  it('windows: two names are one path exactly when NTFS reads them as one (not by JavaScript case)', () => {
    // Letters that look alike or that JavaScript folds together, swapped at random: k, K and the Kelvin sign; ı and I;
    // ß and S; µ and Greek Μ; é, É and e
    const groups = [['k', 'K', '\u212a'], ['ı', 'I'], ['ß', 'S'], ['µ', '\u039c'], ['é', 'É', 'e'], ['a', 'A']]
    const confuse = (r: Rng, s: string) => [...s].map((c) => r.pick(groups.find((g) => g.includes(c)) ?? [c])).join('')
    forAll(
      (r) => {
        const a = name(r)
        return { a, b: confuse(r, a) }
      },
      ({ a, b }) => {
        expect(samePath(`C:\\d\\${a}`, `C:\\d\\${b}`, 'windows')).toBe(sameOnNtfs(a, b))
        expect(isInside(`C:\\d\\${a}`, `C:\\d\\${b}\\x`, 'windows')).toBe(sameOnNtfs(a, b))
        expect(samePath(`/d/${a}`, `/d/${b}`, 'posix')).toBe(a === b)
      },
    )
    // One character never becomes two, and the folded form sorts as NTFS lists (`_` after `Z`)
    expect(foldCase('ß', 'windows')).toBe('ß')
    expect(['_', 'a', 'Z'].sort((x, y) => (foldCase(x, 'windows') < foldCase(y, 'windows') ? -1 : 1))).toEqual(['a', 'Z', '_'])
  })

  it('relative paths resolve from the working folder given, not from the process running the tests', () => {
    expect(pathKey('rel', 'windows', 'D:\\work')).toBe(pathKey('D:\\work\\rel', 'windows'))
    expect(isInside('/work', 'rel', 'posix', '/work')).toBe(true)
    const p = pathRulesFrom('windows', () => 'D:\\work')
    expect(p.resolve('rel')).toBe('D:\\work\\rel')
    expect(p.relative('a', 'D:\\work\\a\\b')).toBe('b')
    expect(pathRulesFrom('posix', () => '/work').resolve('rel')).toBe('/work/rel')
  })

  it('another drive and a parent are outside; a name that only starts with two dots is inside', () => {
    expect(isInside('C:\\a', 'D:\\a\\b', 'windows')).toBe(false)
    expect(isInside('C:\\a\\b', 'C:\\a', 'windows')).toBe(false)
    expect(isInside('/a', '/a/..cache', 'posix')).toBe(true)
    expect(isInside('C:\\a', 'C:\\a\\..cache', 'windows')).toBe(true)
  })
})

describe('the environment and PATH by the family’s rules', () => {
  it("windows reads a variable in any case, an exact name first; posix only by its own name", () => {
    forAll(
      (r) => ({ asked: recase(r, 'Path'), value: name(r) }),
      ({ asked, value }) => {
        expect(envValue({ PATH: value }, asked, 'windows')).toBe(value)
        expect(envValue({ PATH: value }, asked, 'posix')).toBe(asked === 'PATH' ? value : undefined)
      },
    )
    expect(envValue({ Path: 'a', PATH: 'b' }, 'PATH', 'windows')).toBe('b')
  })

  it('finds a tool in the first folder of PATH that has it, by PATHEXT in its order on Windows', () => {
    forAll(
      (r) => {
        const folders = Array.from({ length: r.int(1, 4) }, (_, i) => `C:\\bin${i}`)
        const present = new Set<string>()
        for (const f of folders) for (const ext of ['.exe', '.cmd', '', '.ps1']) if (r.bool(0.3)) present.add(win32.join(f, `tool${ext}`).toLowerCase())
        return { folders, present: [...present], pathExt: r.pick(['.COM;.EXE;.BAT;.CMD', '.CMD;.EXE', undefined]) }
      },
      ({ folders, present, pathExt }) => {
        const exts = (pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
        let want: string | null = null
        for (const f of folders) {
          for (const ext of exts) {
            const c = win32.join(f, `tool${ext}`)
            if (!want && present.includes(c.toLowerCase())) want = c
          }
        }
        const env = { Path: folders.join(';'), ...(pathExt ? { PATHEXT: pathExt } : {}) }
        expect(findOnPath('tool', env, 'windows', (p) => present.includes(p.toLowerCase()))).toBe(want)
      },
    )
  })

  it("reads SystemRoot in any case, and never a relative one (#428)", () => {
    expect(systemTool(['taskkill.exe'], { systemroot: 'D:\\Win' })).toBe('D:\\Win\\System32\\taskkill.exe')
    expect(systemTool(['taskkill.exe'], { SYSTEMROOT: 'Win' })).toBe('C:\\Windows\\System32\\taskkill.exe')
  })

  it('a file URL with an encoded backslash is refused on Windows only, as Node refuses it', () => {
    expect(() => fileUrlToPath('file:///C:/a%5cb', 'windows')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FILE_URL_PATH' }))
    expect(() => fileUrlToPath('file:///C:/a%5Cb', 'windows')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FILE_URL_PATH' }))
    expect(fileUrlToPath('file:///a%5cb', 'posix')).toBe('/a\\b')
  })

  it('a start on Windows tries .com and .exe after a path, and the path as written only when it has an extension', () => {
    expect(programCandidates('C:\\bin\\node', 'windows')).toEqual(['C:\\bin\\node.com', 'C:\\bin\\node.exe'])
    expect(programCandidates('C:\\bin\\a.foo', 'windows')).toEqual(['C:\\bin\\a.foo', 'C:\\bin\\a.foo.com', 'C:\\bin\\a.foo.exe'])
    expect(programCandidates('/usr/bin/node', 'posix')).toEqual(['/usr/bin/node'])
  })

  it('never searches a relative PATH folder on Windows, and reads a quoted one', () => {
    const there = new Set(['C:\\Program Files\\Git\\cmd\\git.exe', 'repo\\git.exe'])
    expect(findOnPath('git', { PATH: 'repo;"C:\\Program Files\\Git\\cmd"' }, 'windows', (p) => there.has(p))).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(findOnPath('git', { PATH: '/usr/bin:/bin' }, 'posix', (p) => p === '/bin/git')).toBe('/bin/git')
  })
})

describe('signals by family', () => {
  it('Windows sends TERM, KILL, INT and QUIT, refuses the other names it knows, and does not know the rest', () => {
    expect(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGQUIT'].map((s) => signalRefusal(s, 'windows'))).toEqual([null, null, null, null])
    expect(['SIGHUP', 'SIGBREAK', 'SIGWINCH', 'SIGABRT'].map((s) => signalRefusal(s, 'windows'))).toEqual(['ENOSYS', 'ENOSYS', 'ENOSYS', 'ENOSYS'])
    expect(['SIGUSR1', 'SIGSTOP', 'SIGPIPE', 'SIGNOPE'].map((s) => signalRefusal(s, 'windows'))).toEqual(Array(4).fill('ERR_UNKNOWN_SIGNAL'))
    expect(['SIGHUP', 'SIGUSR1', 'SIGSTOP', 'SIGCHLD'].map((s) => signalRefusal(s, 'posix'))).toEqual([null, null, null, null])
    expect(signalRefusal('SIGBREAK', 'posix')).toBe('ERR_UNKNOWN_SIGNAL')
  })
})

describe('the questions named for what differs', () => {
  it('are answered once per family', () => {
    expect(traitsOf('windows')).toEqual({
      foldsPathCase: true,
      hasProcessGroups: false,
      locksRunningPrograms: true,
      locksWatchedFolders: true,
      cpKeepsLinks: false,
      clonesFiles: false,
      measuresWithDu: false,
      hasPs: false,
      modesGuardFiles: false,
      hasWindowsFileNames: true,
    })
    const posixTraits = traitsOf('posix')
    for (const [k, v] of Object.entries(traitsOf('windows'))) if (k !== 'clonesFiles') expect(posixTraits[k as keyof typeof posixTraits], k).toBe(!v)
  })
})

describe('Windows path forms Win32 opens as one path', () => {
  it('the \\\\?\\ form of a path is the plain path; a name ending in a dot or a space is a name of its own, as Node opens it', () => {
    expect(samePath('\\\\?\\C:\\x', 'C:\\x', 'windows')).toBe(true)
    expect(samePath('\\\\?\\c:\\X\\y', 'C:\\x\\Y', 'windows')).toBe(true)
    expect(samePath('\\\\?\\C:', 'C:\\', 'windows')).toBe(true)
    expect(samePath('\\\\?\\UNC\\s\\sh\\x', '\\\\s\\sh\\x', 'windows')).toBe(true)
    expect(samePath('\\\\?\\unc\\s\\sh', '\\\\s\\sh', 'windows')).toBe(true)
    expect(isInside('\\\\?\\C:\\x', 'C:\\x\\y', 'windows')).toBe(true)
    // Node reads `y.` and `y` as two files, so a sibling folder `proj.` is not inside `proj`
    expect(samePath('C:\\x\\y.', 'C:\\x\\y', 'windows')).toBe(false)
    expect(isInside('C:\\work\\proj', 'C:\\work\\proj.\\secret', 'windows')).toBe(false)
    expect(isInside('C:\\work\\proj', 'C:\\work\\proj \\secret', 'windows')).toBe(false)
  })
})

describe('linkLoop walks a folder once', () => {
  it('however many links lead to it: a chain of folders each linked twice to the next is not walked as 2^n paths', () => {
    // d0 holds two links to d1, d1 two links to d2, and so on: 2^16 ways down, 17 folders
    const depth = 16
    let listed = 0
    // The folder a path leads to: a link a<n> or b<n> leads to d<n>
    const folderOf = (path: string) => path.split('/').filter(Boolean).reduce((_, seg) => `d${seg.slice(1)}`, 'd0')
    const reader: TreeReader = {
      list: (dir) => {
        listed++
        const n = Number(folderOf(dir).slice(1))
        return n >= depth ? [] : ['a', 'b'].map((name) => ({ name: `${name}${n + 1}`, isDirectory: () => false, isSymbolicLink: () => true }))
      },
      real: (path) => `/${folderOf(path)}`,
      isDir: () => true,
      loops: () => false,
      isJunction: () => true,
    }
    expect(linkLoop('/d0', reader, 'windows', posix.join)).toBeNull()
    expect(listed).toBeLessThan(2 * depth + 5)
  })
})
