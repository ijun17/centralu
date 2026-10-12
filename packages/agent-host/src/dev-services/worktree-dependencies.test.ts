import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
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
const installed = async (folder = '') => {
  const modules = join(main, folder, 'node_modules')
  await mkdir(join(modules, '.store', 'dep'), { recursive: true })
  await writeFile(join(modules, '.store', 'dep', 'index.js'), 'original')
  await symlink('.store/dep', join(modules, 'dep'), 'dir')
}

it.each(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb'])(
  '%s: reuses dependencies as independent files, retaining internal package links', async (name) => {
    await lock(name)
    await installed()
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

it('copies workspace package dependencies before checking sibling links, and removes links outside the child', async () => {
  await lock()
  await installed()
  for (const pkg of ['a', 'b']) {
    for (const cwd of [main, child]) {
      await mkdir(join(cwd, 'packages', pkg), { recursive: true })
      await writeFile(join(cwd, 'packages', pkg, 'package.json'), '{}')
    }
    await installed(join('packages', pkg))
  }
  await symlink('../../b/node_modules/dep', join(main, 'packages', 'a', 'node_modules', 'sibling'), 'dir')
  await symlink(main, join(main, 'node_modules', 'escape'), 'dir')
  await prepareWorktreeDependencies(main, child)
  expect(await readFile(join(child, 'packages', 'a', 'node_modules', 'sibling', 'index.js'), 'utf8')).toBe('original')
  await expect(lstat(join(child, 'node_modules', 'escape'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['no lock', 'different lock', 'different manifest', 'no source modules', 'existing modules', 'existing broken link', 'source escape'])(
  '%s: does not overwrite or reuse unsuitable dependencies', async (kind) => {
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
      await symlink(root, join(main, 'node_modules'), 'dir')
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
