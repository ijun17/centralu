import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { forAll, name, recase, type Rng } from './property.test-helpers.js'
import { envValue, fileUrlToPath, findOnPath, isInside, pathKey, pathRules, pathToFileUrl, samePath, traitsOf, type OsFamily } from './rules.js'

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

  it('never searches a relative PATH folder on Windows, and reads a quoted one', () => {
    const there = new Set(['C:\\Program Files\\Git\\cmd\\git.exe', 'repo\\git.exe'])
    expect(findOnPath('git', { PATH: 'repo;"C:\\Program Files\\Git\\cmd"' }, 'windows', (p) => there.has(p))).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(findOnPath('git', { PATH: '/usr/bin:/bin' }, 'posix', (p) => p === '/bin/git')).toBe('/bin/git')
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
