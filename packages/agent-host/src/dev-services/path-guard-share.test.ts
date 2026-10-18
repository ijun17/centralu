import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
/*
 * Not under the system's temporary folder (#368): the walk lists every folder from the drive down, so each walk here
 * listed it, over SMB for a project opened from a share, and a link spelled with the short name of a folder in it had
 * its entries asked one by one. A developer's machine where many sessions run tests holds thousands of entries there,
 * changing all the time (5,860 on one; a CI runner's is nearly empty), and these tests timed out at 15 s there, alone
 * as well. This folder and those above it hold a few dozen entries that nothing else changes while the tests run.
 */
const QUIET = fileURLToPath(new URL('../../node_modules/.cache/path-guard-share/', import.meta.url))

describe.skipIf(process.platform !== 'win32')('a link leading to a share, on the path guard', () => {
  let top: string
  let root: string
  const links: string[] = []
  beforeEach(() => {
    mkdirSync(QUIET, { recursive: true })
    top = realpathSync.native(mkdtempSync(join(QUIET, 'guard-share-')))
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

  /*
   * CI's Windows runner hands out its temp folder by an 8.3 short name (`C:\Users\RUNNER~1\…`), and a tool writes a
   * link's target in that spelling. The walk refused every name its folder does not list, so every such link was
   * refused as "cannot be checked" (review of #1072). A short name is now matched to the entry it names; a short name
   * of a link to a share is still that link, refused unread (the case above).
   */
  it('follows links whose targets, and a project root, are spelled with short names', async () => {
    const long = join(top, 'a-long-folder-name-for-short-names')
    mkdirSync(join(long, 'project', 'inside'), { recursive: true })
    writeFileSync(join(long, 'project', 'inside', 'a.txt'), 'inside')
    const short = join(top, shortName(long))
    expect(short, 'this volume makes short names').not.toBe(long)
    const shortRoot = join(short, 'project')
    const at = (name: string) => join(long, 'project', name)
    symlinkSync(join(shortRoot, 'inside', 'a.txt'), at('file-link.txt'), 'file')
    symlinkSync(join(shortRoot, 'inside'), at('dir-link'), 'dir')
    links.push(at('dir-link'))
    symlinkSync(join(dirname(top), shortName(top), 'kept', 'secret.txt'), at('out.txt'), 'file')
    for (const root of [shortRoot, join(long, 'project')]) {
      for (const rel of ['file-link.txt', 'dir-link/a.txt']) {
        expect((await assertExistingPath(root, rel)).isFile(), `${root} ${rel}`).toBe(true)
        expect(assertExistingPathSync(root, rel).isFile(), `${root} ${rel}`).toBe(true)
      }
      await expect(assertExistingPath(root, 'out.txt')).rejects.toThrow('outside the project')
      expect(() => assertExistingPathSync(root, 'out.txt')).toThrow('outside the project')
    }
  })

  /*
   * A project that is itself on a share (opened from one on purpose, a mapped drive whose real path is the share,
   * `\\wsl.localhost\…`): its links stay on that share and are followed as before, pnpm's junctions among them. Only a
   * link leading to another host or another share is refused (review of #1072: every link there was refused, since the
   * walk took drive paths only).
   */
  it('on a project opened from a share, follows links that stay on it and refuses one to another host or share', async () => {
    const onShare = share(root)
    link(join(root, 'inside'), 'nm', 'junction')
    link('inside\\a.txt', 'rel.txt', 'file')
    link(`\\\\LOCALHOST\\${root[0]!.toLowerCase()}$${root.slice(2)}\\inside\\a.txt`, 'same-share.txt', 'file')
    link(`${share(top)}\\kept\\secret.txt`, 'share-outside.txt', 'file')
    link(`\\\\127.0.0.1\\${top[0]}$${top.slice(2)}\\kept\\secret.txt`, 'other-host.txt', 'file')
    link(`\\\\localhost\\ADMIN$\\notepad.exe`, 'other-share.exe', 'file')
    for (const rel of ['nm/a.txt', 'rel.txt', 'same-share.txt']) {
      expect((await assertExistingPath(onShare, rel)).isFile(), rel).toBe(true)
      expect(assertExistingPathSync(onShare, rel).isFile(), rel).toBe(true)
    }
    // On the same share but outside the project: followed, then refused as outside it, as on a drive
    await expect(assertExistingPath(onShare, 'share-outside.txt')).rejects.toThrow('outside the project')
    for (const rel of ['other-host.txt', 'other-share.exe']) {
      followed.length = 0
      await expect(assertExistingPath(onShare, rel), rel).rejects.toThrow('leads off this machine')
      expect(() => assertExistingPathSync(onShare, rel), rel).toThrow('leads off this machine')
      expect(followed, rel).toEqual([onShare, onShare])
    }
  })
})
