import type { BigIntStats, Stats } from 'node:fs'
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readTextFile } from './fs.js'

/*
 * The identity checks on a read must hold with NTFS file ids (#368). There a file id is 64 bits, with the record's
 * reuse count in the top 16, so an id is usually above 2^53, and two different files can come out as the same Number:
 * on windows-2022, 1754 of 2000 pairs of files made the way fs-read-safety.test.ts makes them did (0xf50000000be167
 * and 0xf50000000be168). Its swap test then failed about once in 100 runs, having read the outside file.
 *
 * Here every stat is given such an id, the way Node hands it over: exact as a bigint, rounded as a Number. Each file
 * gets its own id in the order it is first seen, 2^60 + 1, 2^60 + 2, ... which all round to 2^60.
 */
const hooks = vi.hoisted((): { beforeOpen?: () => Promise<void> } => ({}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const ids = new Map<string, bigint>()
  const ntfs = <S extends Stats | BigIntStats>(st: S): S => {
    const key = `${String(st.dev)}:${String(st.ino)}`
    if (!ids.has(key)) ids.set(key, (1n << 60n) + BigInt(ids.size + 1))
    const id = ids.get(key)!
    ;(st as { ino: number | bigint }).ino = typeof st.ino === 'bigint' ? id : Number(id)
    return st
  }
  type StatOpts = { bigint?: boolean }
  return {
    ...actual,
    stat: async (path: string, opts?: StatOpts) => ntfs(await actual.stat(path, opts as never)),
    lstat: async (path: string, opts?: StatOpts) => ntfs(await actual.lstat(path, opts as never)),
    open: async (...args: Parameters<typeof actual.open>) => {
      await hooks.beforeOpen?.()
      const handle = await actual.open(...args)
      const real = handle.stat.bind(handle)
      handle.stat = (async (opts?: StatOpts) => ntfs(await real(opts as never))) as typeof handle.stat
      return handle
    },
  }
})

let fixture = ''
let root = ''
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'cc-read-identity-'))
  root = join(fixture, 'project')
  await mkdir(join(root, 'dir'), { recursive: true })
  await mkdir(join(fixture, 'outside'))
  await writeFile(join(root, 'dir', 'file.txt'), 'inside')
  await writeFile(join(fixture, 'outside', 'file.txt'), 'outside sentinel')
})
afterEach(async () => {
  delete hooks.beforeOpen
  await rm(fixture, { recursive: true, force: true })
})

it('a file swapped for one outside the project is caught even when both ids are the same as Numbers', async () => {
  hooks.beforeOpen = async () => {
    await rename(join(root, 'dir'), join(root, 'saved-dir'))
    await symlink(join(fixture, 'outside'), join(root, 'dir'), 'dir')
  }
  await expect(readTextFile(root, 'dir/file.txt')).rejects.toThrow(/changed/i)
})

it('an unchanged file is still read', async () => {
  expect((await readTextFile(root, 'dir/file.txt')).text).toBe('inside')
})
