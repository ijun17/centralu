import { spawnSync } from 'node:child_process'
import { SYMLINK_SKIP_REASON, canSymlink, itSymlink, linkDirAsync } from '../link.test-helpers.js'
import { lstatSync, realpathSync, rmdirSync, symlinkSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareWorktreeDependencies } from './worktree-dependencies.js'

let root: string
let main: string
let child: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-worktree-deps-'))
  main = join(root, 'main')
  child = join(root, 'child')
  for (const cwd of [main, child]) {
    await mkdir(cwd)
    await writeFile(join(cwd, 'package.json'), '{}')
  }
})
afterEach(() => rm(root, { recursive: true, force: true }))

const lock = async (name = 'pnpm-lock.yaml') => {
  for (const cwd of [main, child]) await writeFile(join(cwd, name), 'same lock')
}
// A relative link is what pnpm makes with symlink rights; without them (a junction is always absolute) it is a junction
const installed = async (folder = '', relative = false) => {
  const modules = join(main, folder, 'node_modules')
  await mkdir(join(modules, '.store', 'dep'), { recursive: true })
  await writeFile(join(modules, '.store', 'dep', 'index.js'), 'original')
  if (relative) await symlink('.store/dep', join(modules, 'dep'), 'dir')
  else await linkDirAsync('.store/dep', join(modules, 'dep'))
}

it.for(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb'])(
  '%s: reuses dependencies as independent files, retaining internal package links', async (name, ctx) => {
    if (!canSymlink) return ctx.skip(SYMLINK_SKIP_REASON) // the relative link is the point, and a junction is never relative
    await lock(name)
    await installed('', true)
    await prepareWorktreeDependencies(main, child)
    const path = join(child, 'node_modules', 'dep', 'index.js')
    expect(await readFile(path, 'utf8')).toBe('original')
    expect((await lstat(join(child, 'node_modules'))).isSymbolicLink()).toBe(false)
    // Windows reports the link target with its own separator
    expect((await readlink(join(child, 'node_modules', 'dep'))).replaceAll('\\', '/')).toBe('.store/dep')
    await writeFile(path, 'child change')
    expect(await readFile(join(main, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('original')
  },
)

itSymlink('copies workspace package dependencies before checking sibling links, leads links into the main checkout into the child, and removes links outside both', async () => {
  await lock()
  await installed('', true)
  for (const pkg of ['a', 'b']) {
    for (const cwd of [main, child]) {
      await mkdir(join(cwd, 'packages', pkg), { recursive: true })
      await writeFile(join(cwd, 'packages', pkg, 'package.json'), '{}')
    }
    await installed(join('packages', pkg), true)
  }
  await symlink('../../b/node_modules/dep', join(main, 'packages', 'a', 'node_modules', 'sibling'), 'dir')
  await symlink(main, join(main, 'node_modules', 'escape'), 'dir')
  const outside = join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, join(main, 'node_modules', 'away'), 'dir')
  await prepareWorktreeDependencies(main, child)
  expect(await readFile(join(child, 'packages', 'a', 'node_modules', 'sibling', 'index.js'), 'utf8')).toBe('original')
  // An absolute link into the main checkout must never lead there from the child. Linux and Windows make it again
  // leading to the same place in the child (the copy's `links` rule); macOS clones the tree as it is, so the link
  // still leads into the main checkout and is dropped (#1708).
  const escape = join(child, 'node_modules', 'escape')
  if (process.platform === 'darwin') await expect(lstat(escape)).rejects.toMatchObject({ code: 'ENOENT' })
  else expect(realpathSync.native(escape)).toBe(realpathSync.native(child))
  // A link leading outside both checkouts keeps its target in the copy and is then dropped.
  await expect(lstat(join(child, 'node_modules', 'away'))).rejects.toMatchObject({ code: 'ENOENT' })
})

/*
 * Windows (#849): pnpm without Developer Mode, and npm/yarn workspaces, link folders with junctions, whose targets are
 * absolute paths into the main checkout. `cpSync` copied each one as a real folder, and two junctions pointing at each
 * other ended the host. Junctions exist only on Windows (elsewhere the same call makes an absolute symlink, which the
 * worktree drops as pointing back into the main checkout).
 */
describe.skipIf(process.platform !== 'win32')('junctions on Windows', () => {
  const real = (path: string) => realpathSync.native(path)

  it('makes each junction again pointing into the child, and leaves out one pointing outside the project', async () => {
    await lock()
    const store = join(main, 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep')
    await mkdir(store, { recursive: true })
    await writeFile(join(store, 'index.js'), 'original')
    await symlink(store, join(main, 'node_modules', 'dep'), 'junction')
    for (const pkg of ['a', 'b']) {
      for (const cwd of [main, child]) {
        await mkdir(join(cwd, 'packages', pkg), { recursive: true })
        await writeFile(join(cwd, 'packages', pkg, 'package.json'), '{}')
      }
    }
    await writeFile(join(child, 'packages', 'b', 'index.js'), 'the child\'s b')
    await mkdir(join(main, 'packages', 'a', 'node_modules'))
    await symlink(join(main, 'packages', 'b'), join(main, 'packages', 'a', 'node_modules', 'b'), 'junction')
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await symlink(outside, join(main, 'node_modules', 'outside'), 'junction')

    await prepareWorktreeDependencies(main, child)

    const dep = join(child, 'node_modules', 'dep')
    expect((await lstat(dep)).isSymbolicLink()).toBe(true)
    expect(real(dep)).toBe(real(join(child, 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep')))
    await writeFile(join(dep, 'index.js'), 'child change')
    expect(await readFile(join(store, 'index.js'), 'utf8')).toBe('original')
    // The workspace link leads to the child's own package, not a frozen copy of the main checkout's
    const b = join(child, 'packages', 'a', 'node_modules', 'b')
    expect((await lstat(b)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(b, 'index.js'), 'utf8')).toBe('the child\'s b')
    await expect(lstat(join(child, 'node_modules', 'outside'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('copies two junctions that point at each other without following them', async () => {
    await lock()
    await installed()
    const one = join(main, 'node_modules', 'one')
    const two = join(main, 'node_modules', 'two')
    await mkdir(one)
    await mkdir(two)
    await symlink(two, join(one, 'to-two'), 'junction')
    await symlink(one, join(two, 'to-one'), 'junction')

    await prepareWorktreeDependencies(main, child)

    expect(real(join(child, 'node_modules', 'one', 'to-two'))).toBe(real(join(child, 'node_modules', 'two')))
    expect(real(join(child, 'node_modules', 'two', 'to-one'))).toBe(real(join(child, 'node_modules', 'one')))
    expect(await readFile(join(child, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('original')
  })

  /*
   * A junction to a volume path (`\??\Volume{…}\…`) instead of a drive letter needs no privilege to make, and libuv
   * cannot read it: readlink fails and lstat follows it and reports a plain folder. The walk took it for one, and
   * copied what it led to: a folder outside the project as real files, or, led back into the project's own
   * node_modules, itself inside itself until the path was too long.
   */
  describe('a junction to a volume path, which readlink cannot read', () => {
    const made: string[] = []
    // Removed as links: a recursive rm, like lstat, would go through them into what they lead to
    afterEach(() => {
      for (const link of made.splice(0)) rmdirSync(link)
    })
    const viaVolume = (path: string) => {
      const mountvol = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'mountvol.exe')
      const volume = spawnSync(mountvol, [path.slice(0, 2), '/L'], { encoding: 'utf8' }).stdout.trim()
      expect(volume).toMatch(/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i)
      return volume + real(path).slice(3)
    }
    const junction = (target: string, at: string) => {
      symlinkSync(viaVolume(target), at, 'junction')
      made.push(at)
      // What the walk had to go by
      expect(lstatSync(at).isSymbolicLink()).toBe(false)
    }

    it('leaves out one that leads outside the project, instead of copying that folder in', async () => {
      await lock()
      await installed()
      const outside = join(root, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'secret.txt'), 'outside')
      junction(outside, join(main, 'node_modules', 'elsewhere'))

      await prepareWorktreeDependencies(main, child)

      await expect(lstat(join(child, 'node_modules', 'elsewhere'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(child, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('original')
    })

    it('leaves out one that leads back into the copy, instead of copying it into itself', async () => {
      await lock()
      await installed()
      junction(join(main, 'node_modules'), join(main, 'node_modules', 'again'))

      await prepareWorktreeDependencies(main, child)

      await expect(lstat(join(child, 'node_modules', 'again'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(child, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('original')
    })
  })
})

it.for(['no lock', 'different lock', 'different manifest', 'no source modules', 'existing modules', 'existing broken link', 'source escape'])(
  '%s: does not overwrite or reuse unsuitable dependencies', async (kind, ctx) => {
    if (kind === 'existing broken link' && !canSymlink) return ctx.skip(SYMLINK_SKIP_REASON) // a relative link to nothing
    if (kind !== 'no lock') await lock()
    if (kind !== 'no source modules') await installed()
    if (kind === 'different lock') await writeFile(join(child, 'pnpm-lock.yaml'), 'other lock')
    if (kind === 'different manifest') await writeFile(join(child, 'package.json'), '{"dependencies":{}}')
    if (kind === 'existing modules') {
      await mkdir(join(child, 'node_modules'))
      await writeFile(join(child, 'node_modules', 'keep'), 'keep')
    }
    if (kind === 'existing broken link') await symlink('missing', join(child, 'node_modules'), 'dir')
    if (kind === 'source escape') {
      await rm(join(main, 'node_modules'), { recursive: true })
      await linkDirAsync(root, join(main, 'node_modules'))
    }
    await prepareWorktreeDependencies(main, child)
    if (kind === 'existing modules') {
      expect(await readFile(join(child, 'node_modules', 'keep'), 'utf8')).toBe('keep')
      await expect(lstat(join(child, 'node_modules', 'dep'))).rejects.toMatchObject({ code: 'ENOENT' })
    } else if (kind === 'existing broken link') {
      expect(await readlink(join(child, 'node_modules'))).toBe('missing')
    } else await expect(lstat(join(child, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)
