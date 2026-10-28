import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copiedLinkKind, copySteps, type CopyAnswer, type CopyStep } from './copy.js'
import type { OsDirent, OsStats } from './port.js'

/**
 * The `Os`'s tree copy (#1650, os/copy.ts) as the steps it takes, over a tree that only answers: what it reads and
 * makes, whatever the OS. The contract cases (contract.test-helpers.ts) hold the copy to the real OS.
 */

type Entry = { kind: 'dir' } | { kind: 'file' } | { kind: 'link'; target: string }

/** Runs the copy of `from` over `tree` (by POSIX path) and answers the steps it took */
function stepsOver(tree: Map<string, Entry>, from: string, to: string, change?: (step: CopyStep) => void): CopyStep[] {
  const taken: CopyStep[] = []
  let ino = 1n
  const inos = new Map<string, bigint>()
  const stats = (path: string, e: Entry): OsStats => {
    let i = inos.get(path)
    if (i === undefined) inos.set(path, (i = ino++))
    return {
      isFile: () => e.kind === 'file',
      isDirectory: () => e.kind === 'dir',
      isSymbolicLink: () => e.kind === 'link',
      size: 0,
      mode: e.kind === 'dir' ? 0o755 : 0o644,
      uid: 0,
      nlink: 1,
      dev: 1n,
      ino: i,
      atimeMs: 0,
      mtimeMs: 0,
      mtimeNs: 0n,
      ctimeMs: 0,
      birthtimeMs: 0,
    }
  }
  const answer = (s: CopyStep): CopyAnswer => {
    switch (s.op) {
      case 'lstat': {
        const e = tree.get(s.path)
        return { op: 'lstat', stat: e && stats(s.path, e) }
      }
      case 'list': {
        const e = tree.get(s.path)
        if (e?.kind !== 'dir') throw new Error(`listed ${s.path}, which is not a folder`)
        // A copy that follows a link back up would list for ever
        if (taken.filter((t) => t.op === 'list').length > 50) throw new Error('listed without end')
        const entries = [...tree.keys()]
          .filter((p) => posix.dirname(p) === s.path && p !== s.path)
          .map((p): OsDirent => {
            const c = tree.get(p)
            return { name: posix.basename(p), parentPath: s.path, isFile: () => c?.kind === 'file', isDirectory: () => c?.kind === 'dir', isSymbolicLink: () => c?.kind === 'link' }
          })
        return { op: 'list', entries }
      }
      case 'leadsToFolder': {
        const e = tree.get(s.path)
        return { op: 'leadsToFolder', yes: e?.kind === 'link' && tree.get(posix.resolve(posix.dirname(s.path), e.target))?.kind === 'dir' }
      }
      case 'real':
        return { op: 'real', path: tree.has(s.path) ? s.path : null }
      case 'readlink': {
        const e = tree.get(s.path)
        if (e?.kind !== 'link') throw new Error(`readlink of ${s.path}`)
        return { op: 'readlink', text: e.target }
      }
      default:
        return { op: 'done' }
    }
  }
  const steps = copySteps(from, to, { recursive: true, verbatimSymlinks: true }, 'posix', posix)
  for (let s = steps.next(); !s.done; ) {
    taken.push(s.value)
    const a = answer(s.value)
    change?.(s.value)
    s = steps.next(a)
  }
  return taken
}

const listed = (steps: CopyStep[]) => steps.flatMap((s) => (s.op === 'list' ? [s.path] : []))
const made = (steps: CopyStep[]) => steps.flatMap((s) => (s.op === 'symlink' ? [`${s.path} -> ${s.target}`] : []))

describe('the tree copy never follows a link', () => {
  it('a link back to the root, and links in a circle, are made again as links and never listed', () => {
    const tree = new Map<string, Entry>([
      ['/t', { kind: 'dir' }],
      ['/t/d', { kind: 'dir' }],
      ['/t/d/f', { kind: 'file' }],
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
    const tree = new Map<string, Entry>([
      ['/t', { kind: 'dir' }],
      ['/t/a', { kind: 'dir' }],
      ['/t/a/f', { kind: 'file' }],
    ])
    // Once the root is listed, `a` is swapped for a link back to the root
    const steps = stepsOver(tree, '/t', '/out', (s) => {
      if (s.op === 'list' && s.path === '/t') {
        tree.delete('/t/a/f')
        tree.set('/t/a', { kind: 'link', target: '/t' })
      }
    })
    // The listing said folder, `lstat` says link now: made as a link, never listed
    expect(listed(steps)).toEqual(['/t'])
    expect(made(steps)).toEqual(['/out/a -> /t'])
  })
})

describe('the kind of link a copy makes', () => {
  it('on Windows: a junction to a folder at a whole drive path, a directory symlink for a relative one or a share, a file symlink otherwise; none on POSIX', () => {
    expect(copiedLinkKind('C:\\work\\x', true, 'windows')).toBe('junction')
    expect(copiedLinkKind('d:/work/x', true, 'windows')).toBe('junction')
    expect(copiedLinkKind('..\\x', true, 'windows')).toBe('dir')
    expect(copiedLinkKind('\\\\server\\share\\x', true, 'windows')).toBe('dir')
    expect(copiedLinkKind('C:\\work\\f.txt', false, 'windows')).toBe('file')
    expect(copiedLinkKind('/t', true, 'posix')).toBeUndefined()
  })
})
