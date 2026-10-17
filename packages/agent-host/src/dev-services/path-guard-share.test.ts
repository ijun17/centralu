import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * Every realpath the guard asks, so a test can see that a link was never followed: following one that leads to a share
 * is already the connection, and the old guard refused it too, only afterwards, as outside the project.
 */
const followed = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    realpath: (path: string, ...rest: unknown[]) => {
      followed.push(String(path))
      return (fs.realpath as (...a: unknown[]) => Promise<string>)(path, ...rest)
    },
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const native = (path: string, ...rest: unknown[]) => {
    followed.push(String(path))
    return (fs.realpathSync.native as (...a: unknown[]) => string)(path, ...rest)
  }
  return { ...fs, realpathSync: Object.assign((...a: unknown[]) => (fs.realpathSync as (...b: unknown[]) => string)(...a), { native }) }
})

const { assertExistingPath, assertExistingPathSync, UnsafePathError } = await import('./path-guard.js')

/*
 * #849 follow-up: the path guard followed a link with `realpath` to see whether it stayed inside the project, and a
 * symlink leading to a share (`docs -> \\host\share`) made Windows open that share over SMB and offer the person's
 * sign-in before the guard refused it. A repository can carry such a symlink (git makes one where symlinks are on).
 * The links here name this machine's own administrative share, so the old guard reached only localhost.
 */
describe.skipIf(process.platform !== 'win32')('a link leading to a share, on the path guard', () => {
  let top: string
  let root: string
  const links: string[] = []
  beforeEach(() => {
    top = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-guard-share-')))
    root = join(top, 'project')
    mkdirSync(join(root, 'inside'), { recursive: true })
    writeFileSync(join(root, 'inside', 'a.txt'), 'inside')
    mkdirSync(join(top, 'kept'))
    writeFileSync(join(top, 'kept', 'secret.txt'), 'outside')
  })
  afterEach(() => {
    for (const l of links.splice(0)) rmdirSync(l) // as a link: a recursive rm would go through it
    rmSync(top, { recursive: true, force: true })
  })
  const share = (path: string) => `\\\\localhost\\${path[0]}$${path.slice(2)}`
  const link = (target: string, name: string, type: 'file' | 'dir' | 'junction') => {
    symlinkSync(target, join(root, name), type)
    if (type !== 'file') links.push(join(root, name))
  }
  const shortName = (path: string) =>
    basename(
      spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
        windowsVerbatimArguments: true,
        encoding: 'utf8',
      }).stdout.trim(),
    )

  it('refuses it without following it, on the async walk and on the sync one, however the link is reached', async () => {
    const mountvol = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'mountvol.exe')
    const volume = execFileSync(mountvol, [top.slice(0, 2), '/L'], { encoding: 'utf8' }).trim()
    link(`${share(top)}\\kept\\secret.txt`, 'shot-link.txt', 'file')
    link(`\\\\?\\UNC\\localhost\\${top[0]}$${top.slice(2)}\\kept\\secret.txt`, 'device.txt', 'file')
    link(share(join(top, 'kept')), 'remote', 'dir')
    // A chain of local links ending in one, and a link to a junction whose target cannot be read
    link('shot-link.txt', 'hop.txt', 'file')
    link(`${volume}${top.slice(3)}\\kept`, 'volume-junction', 'junction')
    link('volume-junction', 'to-junction', 'dir')
    const short = shortName(join(root, 'shot-link.txt'))
    expect(short, 'this volume makes short names').not.toBe('shot-link.txt')
    for (const rel of ['shot-link.txt', 'SHOT-LINK.TXT', short, 'device.txt', 'remote/secret.txt', 'hop.txt', 'to-junction/secret.txt']) {
      followed.length = 0
      await expect(assertExistingPath(root, rel), rel).rejects.toThrow(UnsafePathError)
      expect(() => assertExistingPathSync(root, rel), rel).toThrow(UnsafePathError)
      // The project folder itself, once per walk, and nothing else: no link was followed
      expect(followed, rel).toEqual([root, root])
    }
  })

  it('still follows a local link inside the project', async () => {
    link('inside\\a.txt', 'near.txt', 'file')
    link(join(root, 'inside'), 'folder-link', 'junction')
    for (const rel of ['near.txt', 'folder-link/a.txt']) {
      expect((await assertExistingPath(root, rel)).isFile(), rel).toBe(true)
      expect(assertExistingPathSync(root, rel).isFile(), rel).toBe(true)
    }
  })
})
