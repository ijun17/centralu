import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { readTextFile, resolveExisting } from './fs.js'

const hooks = vi.hoisted((): {
  beforeOpen?: () => Promise<void>
  beforeRealpath?: (path: Parameters<typeof realpath>[0]) => Promise<void>
  handle?: FileHandle
  read?: MockInstance<FileHandle['read']>
} => ({}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      await hooks.beforeRealpath?.(args[0])
      return actual.realpath(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      await hooks.beforeOpen?.()
      const handle = await actual.open(...args)
      hooks.handle = handle
      hooks.read = vi.spyOn(handle, 'read')
      return handle
    },
  }
})

let fixture = ''
let root = ''
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'cc-read-safety-'))
  root = join(fixture, 'project')
  await mkdir(join(root, 'dir'), { recursive: true })
  await mkdir(join(fixture, 'outside'))
  await writeFile(join(root, 'dir', 'file.txt'), 'inside')
  await writeFile(join(fixture, 'outside', 'file.txt'), 'outside sentinel')
})
afterEach(async () => {
  delete hooks.beforeRealpath
  delete hooks.beforeOpen
  delete hooks.handle
  delete hooks.read
  vi.restoreAllMocks()
  await rm(fixture, { recursive: true, force: true })
})

it('rejects an opened object changed after validation without reading its contents', async () => {
  hooks.beforeOpen = async () => {
    await rename(join(root, 'dir'), join(root, 'saved-dir'))
    await symlink(join(fixture, 'outside'), join(root, 'dir'), 'dir')
  }
  await expect(readTextFile(root, 'dir/file.txt')).rejects.toThrow(/changed/i)
  expect(hooks.read).not.toHaveBeenCalled()
  expect(hooks.handle?.fd).toBe(-1)
})

it.skipIf(process.platform === 'win32')('rejects a FIFO before opening or waiting for a writer', async () => {
  const fifo = join(root, 'pipe')
  execFileSync('mkfifo', [fifo])
  await expect(readTextFile(root, 'pipe')).rejects.toThrow(/regular file/i)
  expect(hooks.handle).toBeUndefined()
})

it('returns canonical paths for project-root aliases before native handoff', async () => {
  const alias = join(fixture, 'project-alias')
  await symlink(root, alias, 'dir')
  expect(await resolveExisting(alias, 'dir/file.txt')).toBe(await realpath(join(root, 'dir/file.txt')))
})

it('rejects a target redirected outside the project during canonical resolution', async () => {
  hooks.beforeRealpath = async (path) => {
    if (path !== join(root, 'dir/file.txt')) return
    delete hooks.beforeRealpath
    await rename(join(root, 'dir'), join(root, 'saved-dir'))
    await symlink(join(fixture, 'outside'), join(root, 'dir'), 'dir')
  }
  await expect(resolveExisting(root, 'dir/file.txt')).rejects.toThrow(/outside the project|changed/i)
})
