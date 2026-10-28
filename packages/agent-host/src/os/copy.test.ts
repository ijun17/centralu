import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copiedLinkKind, copySteps, type CopyAnswer, type CopyStep } from './copy.js'
import type { CopyTreeOptions, OsDirent, OsStats } from './port.js'
import { retarget } from './rules.js'

/**
 * The `Os`'s tree copy (#1650, os/copy.ts) as the steps it takes, over a tree that only answers: what it reads and
 * makes, whatever the OS. The contract cases (contract.test-helpers.ts) hold the copy to the real OS.
 */

type Entry =
  | { kind: 'dir' }
  | { kind: 'file' }
  | { kind: 'link'; target: string }
  /** A folder at a second name that is no link (a share to the same disk, a bind mount): `realpath` keeps the name */
  | { kind: 'mount'; target: string }
  /** A reparse point `lstat` cannot read (a junction to a volume path): a link to the listing, a folder to `lstat` */
  | { kind: 'reparse'; target: string }
  | { kind: 'fifo' }

type Over = { options?: CopyTreeOptions; change?: (step: CopyStep) => void; noNumbers?: boolean }

/** Runs the copy of `from` over `tree` (by POSIX path) and answers the steps it took */
function stepsOver(tree: Map<string, Entry>, from: string, to: string, over: Over = {}): CopyStep[] {
  const taken: CopyStep[] = []
  let ino = 1n
  const inos = new Map<string, bigint>()
  const stats = (path: string, e: Entry): OsStats => {
    let i = inos.get(path)
    if (i === undefined) inos.set(path, (i = ino++))
    const folder = e.kind === 'dir' || e.kind === 'reparse'
    return {
      isFile: () => e.kind === 'file',
      isDirectory: () => folder,
      isSymbolicLink: () => e.kind === 'link',
      size: 0,
      mode: folder ? 0o755 : 0o644,
      uid: 0,
      nlink: 1,
      dev: over.noNumbers ? 0n : 1n,
      ino: over.noNumbers ? 0n : i,
      atimeMs: 0,
      mtimeMs: 0,
      mtimeNs: 0n,
      ctimeMs: 0,
      birthtimeMs: 0,
    }
  }
  /** Where `path` is in the tree: through links on the way (and the last with `follow`), and through mounts unless `real` */
  const walk = (path: string, follow: boolean, real = false, hops = 0): string | null => {
    const parts = path.split('/').filter(Boolean)
    let at = '/'
    for (const [i, part] of parts.entries()) {
      const next = posix.join(at, part)
      const e = tree.get(next)
      const last = i === parts.length - 1
      if ((e?.kind === 'mount' && !real) || (e?.kind === 'link' && (!last || follow))) {
        if (hops > 20) throw Object.assign(new Error(`ELOOP: ${path}`), { code: 'ELOOP' })
        return walk(posix.join(posix.resolve(at, e.target), ...parts.slice(i + 1)), follow, real, hops + 1)
      }
      if (!e && !last) return null
      at = next
    }
    return at
  }
  const entryAt = (path: string, follow: boolean) => {
    const key = walk(path, follow)
    const e = key === null ? undefined : tree.get(key)
    return key !== null && e ? stats(key, e) : undefined
  }
  const answer = (s: CopyStep): CopyAnswer => {
    switch (s.op) {
      case 'lstat':
        return { op: 'lstat', stat: entryAt(s.path, false) }
      case 'stat':
        return { op: 'stat', stat: entryAt(s.path, true) }
      case 'list': {
        const key = walk(s.path, true)
        const e = key === null ? undefined : tree.get(key)
        if (key === null || e?.kind !== 'dir') throw new Error(`listed ${s.path}, which is not a folder`)
        // A copy that follows a link back up would list for ever
        if (taken.filter((t) => t.op === 'list').length > 50) throw new Error('listed without end')
        const entries = [...tree.keys()]
          .filter((p) => posix.dirname(p) === key && p !== key)
          .map((p): OsDirent => {
            const c = tree.get(p)
            const link = c?.kind === 'link' || c?.kind === 'reparse'
            return { name: posix.basename(p), parentPath: s.path, isFile: () => c?.kind === 'file', isDirectory: () => c?.kind === 'dir' || c?.kind === 'mount', isSymbolicLink: () => link }
          })
        return { op: 'list', entries }
      }
      case 'leadsToFolder':
        return { op: 'leadsToFolder', yes: entryAt(s.path, true)?.isDirectory() ?? false }
      case 'real': {
        const key = walk(s.path, true, true)
        return { op: 'real', path: key !== null && tree.has(key) ? key : null }
      }
      case 'readlink': {
        const e = tree.get(s.path)
        if (e?.kind !== 'link' && e?.kind !== 'reparse') throw new Error(`readlink of ${s.path}`)
        return { op: 'readlink', text: e.target }
      }
      default:
        return { op: 'done' }
    }
  }
  const steps = copySteps(from, to, over.options ?? { recursive: true, verbatimSymlinks: true }, 'posix', posix)
  for (let s = steps.next(); !s.done; ) {
    taken.push(s.value)
    const a = answer(s.value)
    over.change?.(s.value)
    s = steps.next(a)
  }
  return taken
}

const listed = (steps: CopyStep[]) => steps.flatMap((s) => (s.op === 'list' ? [s.path] : []))
const made = (steps: CopyStep[]) => steps.flatMap((s) => (s.op === 'symlink' ? [`${s.path} -> ${s.target}`] : []))
const codeOf = (fn: () => unknown) => {
  try {
    fn()
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  }
}
const treeOf = (entries: [string, Entry][]) => new Map<string, Entry>(entries)
const dir: Entry = { kind: 'dir' }
const file: Entry = { kind: 'file' }

describe('the tree copy never follows a link', () => {
  it('a link back to the root, and links in a circle, are made again as links and never listed', () => {
    const tree = treeOf([
      ['/t', dir],
      ['/t/d', dir],
      ['/t/d/f', file],
      ['/t/d/up', { kind: 'link', target: '/t' }],
      ['/t/a', { kind: 'link', target: 'b' }],
      ['/t/b', { kind: 'link', target: 'a' }],
    ])
    const steps = stepsOver(tree, '/t', '/out')
    expect(listed(steps)).toEqual(['/t', '/t/d'])
    expect(made(steps)).toEqual(['/out/d/up -> /t', '/out/a -> b', '/out/b -> a'])
    expect(steps).toContainEqual({ op: 'copyFile', from: '/t/d/f', to: '/out/d/f' })
  })

  it('a folder that becomes a link while the tree is copied is not entered (the race a check before the copy lost)', () => {
    const tree = treeOf([
      ['/t', dir],
      ['/t/a', dir],
      ['/t/a/f', file],
    ])
    // Once the root is listed, `a` is swapped for a link back to the root
    const steps = stepsOver(tree, '/t', '/out', {
      change: (s) => {
        if (s.op === 'list' && s.path === '/t') {
          tree.delete('/t/a/f')
          tree.set('/t/a', { kind: 'link', target: '/t' })
        }
      },
    })
    // The listing said folder, `lstat` says link now: made as a link, never listed
    expect(listed(steps)).toEqual(['/t'])
    expect(made(steps)).toEqual(['/out/a -> /t'])
  })

  it('an entry the listing calls a link is made as a link, though `lstat` calls it a folder (a reparse point it cannot read)', () => {
    const tree = treeOf([
      ['/t', dir],
      ['/t/v', { kind: 'reparse', target: '/elsewhere' }],
    ])
    const steps = stepsOver(tree, '/t', '/out')
    expect(listed(steps)).toEqual(['/t'])
    expect(made(steps)).toEqual(['/out/v -> /elsewhere'])
  })

  it('an entry gone since its folder was listed is not copied, and the copy goes on', () => {
    const tree = treeOf([
      ['/t', dir],
      ['/t/a', file],
      ['/t/b', file],
    ])
    const steps = stepsOver(tree, '/t', '/out', { change: (s) => s.op === 'list' && tree.delete('/t/a') })
    expect(steps.filter((s) => s.op === 'copyFile')).toEqual([{ op: 'copyFile', from: '/t/b', to: '/out/b' }])
  })
})

describe('the tree copy refuses what Node refuses', () => {
  const t = treeOf([
    ['/t', dir],
    ['/t/f', file],
  ])
  it('a copy into itself: by name, past parents not made yet, through a link, and through another name that is no link (a share, a bind mount)', () => {
    const tree = new Map([...t, ['/L', { kind: 'link', target: '/t' }] as const, ['/share', { kind: 'mount', target: '/t' }] as const])
    expect(codeOf(() => stepsOver(tree, '/t', '/t/a/b'))).toBe('ERR_FS_CP_EINVAL')
    // Node stops at the first parent not there and copies `/t` into itself through `L`
    expect(codeOf(() => stepsOver(tree, '/t', '/L/a/b/c'))).toBe('ERR_FS_CP_EINVAL')
    // `realpath` of a share does not lead back to the drive: only the entry's numbers tell
    expect(codeOf(() => stepsOver(tree, '/t', '/share/sub'))).toBe('ERR_FS_CP_EINVAL')
    expect(codeOf(() => stepsOver(tree, '/t', '/out/a'))).toBe('ok')
  })

  it('an entry the volume gives no number is no other entry (Node: `ino` or `dev` 0)', () => {
    // `/p`, a parent of the target, would be the source by its numbers
    const tree = new Map([...t, ['/p', dir] as const])
    expect(codeOf(() => stepsOver(tree, '/t', '/p/out', { noNumbers: true }))).toBe('ok')
  })

  it('below the root: a folder onto a non-folder, a non-folder onto a folder', () => {
    const tree = treeOf([
      ['/t', dir],
      ['/t/d', dir],
      ['/t/d/x', file],
      ['/out', dir],
      ['/out/d', file],
    ])
    expect(codeOf(() => stepsOver(tree, '/t', '/out'))).toBe('ERR_FS_CP_DIR_TO_NON_DIR')
    tree.set('/t/d', file)
    tree.delete('/t/d/x')
    tree.set('/out/d', dir)
    expect(codeOf(() => stepsOver(tree, '/t', '/out'))).toBe('ERR_FS_CP_NON_DIR_TO_DIR')
  })

  it('anything not a file, folder or link (a FIFO, which copyFile would wait on for ever) is ERR_FS_CP_UNKNOWN', () => {
    const tree = treeOf([
      ['/t', dir],
      ['/t/p', { kind: 'fifo' }],
    ])
    let copied = false
    expect(codeOf(() => stepsOver(tree, '/t', '/out', { change: (s) => (copied ||= s.op === 'copyFile') }))).toBe('ERR_FS_CP_UNKNOWN')
    expect(copied).toBe(false)
  })
})

describe('the tree copy into a folder already there', () => {
  it('keeps the mode of a folder already there; a folder it makes takes its source mode', () => {
    const tree = treeOf([
      ['/t', dir],
      ['/t/d', dir],
      ['/t/n', dir],
      ['/out', dir],
      ['/out/d', dir],
    ])
    const steps = stepsOver(tree, '/t', '/out')
    expect(steps.filter((s) => s.op === 'chmod').map((s) => s.op === 'chmod' && s.path)).toEqual(['/out/n'])
  })
})

describe('with `links`, a link into the tree leads into the copy', () => {
  const tree = treeOf([
    ['/t', dir],
    ['/t/sub', dir],
    ['/elsewhere', dir],
    ['/A', { kind: 'link', target: '/t' }],
    ['/t/abs', { kind: 'link', target: '/t/sub' }],
    ['/t/rel', { kind: 'link', target: 'sub' }],
    ['/t/out', { kind: 'link', target: '/elsewhere' }],
    ['/t/via', { kind: 'link', target: '/A/sub' }],
    ['/t/gone', { kind: 'link', target: '/nowhere/x' }],
  ])
  const links = { from: '/t', to: '/final' }

  it('a whole target inside (by name, or where it really leads) at the same place in `to`; a relative one, and any other, as written', () => {
    // Copied beside its place (`/tmp1`) and renamed to `/final`: the links lead where the copy will stand
    expect(made(stepsOver(tree, '/t', '/tmp1', { options: { recursive: true, verbatimSymlinks: true, links } }))).toEqual([
      '/tmp1/abs -> /final/sub',
      '/tmp1/rel -> sub',
      '/tmp1/out -> /elsewhere',
      '/tmp1/via -> /final/sub',
      '/tmp1/gone -> /nowhere/x',
    ])
    // Without verbatimSymlinks, Node's rule makes the relative one whole into the tree first
    expect(made(stepsOver(tree, '/t', '/tmp1', { options: { recursive: true, links } }))).toContain('/tmp1/rel -> /final/sub')
  })

  it("without it every link keeps its target, as Node's cp", () => {
    expect(made(stepsOver(tree, '/t', '/out'))).toEqual(['/out/abs -> /t/sub', '/out/rel -> sub', '/out/out -> /elsewhere', '/out/via -> /A/sub', '/out/gone -> /nowhere/x'])
  })

  it('the rule, one for the copy and the worktree copy on Windows: inside by segment and case, the `\\\\?\\` form too', () => {
    expect(retarget('/t/sub/x', links, 'posix')).toBe('/final/sub/x')
    expect(retarget('/t', links, 'posix')).toBe('/final')
    expect(retarget('/tt/x', links, 'posix')).toBeNull()
    expect(retarget('\\\\?\\c:\\Data\\T\\sub', { from: 'C:\\data\\t', to: 'D:\\new' }, 'windows')).toBe('D:\\new\\sub')
    expect(retarget('C:\\data\\t\\sub', { from: '\\\\?\\C:\\data\\t', to: 'D:\\new' }, 'windows')).toBe('D:\\new\\sub')
    expect(retarget('C:\\data\\t2', { from: 'C:\\data\\t', to: 'D:\\new' }, 'windows')).toBeNull()
  })
})

describe('the kind of link a copy makes', () => {
  it('on Windows: a junction to a folder at a whole drive path, a directory symlink for a relative one or a share, a file symlink otherwise; none on POSIX', () => {
    expect(copiedLinkKind('C:\\work\\x', true, 'windows')).toBe('junction')
    expect(copiedLinkKind('d:/work/x', true, 'windows')).toBe('junction')
    expect(copiedLinkKind('\\\\?\\C:\\work\\x', true, 'windows')).toBe('junction')
    expect(copiedLinkKind('C:x', true, 'windows')).toBe('dir')
    expect(copiedLinkKind('..\\x', true, 'windows')).toBe('dir')
    expect(copiedLinkKind('\\\\server\\share\\x', true, 'windows')).toBe('dir')
    expect(copiedLinkKind('C:\\work\\f.txt', false, 'windows')).toBe('file')
    expect(copiedLinkKind('/t', true, 'posix')).toBeUndefined()
  })
})
