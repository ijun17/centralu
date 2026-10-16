import { chmod, mkdtemp, readdir, symlink, writeFile, mkdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearAttachments, saveAttachment, sweepAttachments } from './attachments.js'

/**
 * The cap on total size (#40 part 2, the owner's decision of 500MB — this test measures the same
 * rule with a small cap). The contract: once over the cap, delete **the oldest files first**, and
 * only until it drops back below.
 */

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-att-'))
  process.env.CC_DATA_DIR = dir
})
afterEach(async () => {
  delete process.env.CC_DATA_DIR
  await rm(dir, { recursive: true, force: true })
})

async function put(session: string, name: string, bytes: number, ageSec: number): Promise<string> {
  const d = join(dir, 'attachments', session)
  await mkdir(d, { recursive: true })
  const p = join(d, name)
  await writeFile(p, Buffer.alloc(bytes, 1))
  const t = new Date(Date.now() - ageSec * 1000)
  await utimes(p, t, t)
  return p
}

describe('sweepAttachments', () => {
  it('deletes nothing when under the cap', async () => {
    await put('s1', 'a.png', 100, 60)
    expect(await sweepAttachments(1000)).toBe(0)
    expect(await readdir(join(dir, 'attachments', 's1'))).toEqual(['a.png'])
  })

  it('once over the cap, deletes the oldest first, and only until it drops back below', async () => {
    await put('s1', 'old.png', 400, 300)
    await put('s2', 'mid.png', 400, 200)
    await put('s1', 'new.png', 400, 100)
    // total 1200, cap 900 -> deleting just old brings it down to 800
    expect(await sweepAttachments(900)).toBe(1)
    expect(await readdir(join(dir, 'attachments', 's1'))).toEqual(['new.png'])
    expect(await readdir(join(dir, 'attachments', 's2'))).toEqual(['mid.png'])
  })

  // chmod cannot stop a removal on Windows, nor for root; a link needs a privilege on Windows
  const posixUser = process.platform !== 'win32' && process.getuid?.() !== 0 ? it : it.skip

  posixUser('a file that cannot be removed still counts, so the sweep goes on to the next oldest (#841)', async () => {
    await put('held', 'old.png', 400, 300)
    await put('s2', 'mid.png', 400, 200)
    await put('s1', 'new.png', 400, 100)
    const held = join(dir, 'attachments', 'held')
    await chmod(held, 0o500)
    try {
      // total 1200, cap 900: old cannot go, so mid goes in its place
      expect(await sweepAttachments(900)).toBe(1)
      expect(await readdir(held)).toEqual(['old.png'])
      expect(await readdir(join(dir, 'attachments', 's2'))).toEqual([])
      expect(await readdir(join(dir, 'attachments', 's1'))).toEqual(['new.png'])
    } finally {
      await chmod(held, 0o700)
    }
  })

  posixUser('a link in an attachment folder is not counted toward the cap by the size of what it points at', async () => {
    const outside = join(dir, 'big.bin')
    await writeFile(outside, Buffer.alloc(5000, 1))
    await put('s1', 'a.png', 100, 60)
    await symlink(outside, join(dir, 'attachments', 's1', 'linked.png'))
    expect(await sweepAttachments(1000)).toBe(0)
    expect((await readdir(join(dir, 'attachments', 's1'))).sort()).toEqual(['a.png', 'linked.png'])
  })

  it('quietly returns 0 even when the folder does not exist yet', async () => {
    expect(await sweepAttachments(10)).toBe(0)
  })
})

/**
 * A session id is a path segment, not a path (#94).
 *
 * This measures exactly what was found before the fix: `clearAttachments('../../Documents')`
 * deleted, with `recursive: true`, the folder two levels above the attachments root, and
 * `saveAttachment` given the same id created a file there with whatever extension an attacker
 * chose.
 */
describe('a session id that leaves the path is rejected (#94)', () => {
  it('deleting: cannot touch a folder outside the attachments root', async () => {
    const victim = join(dir, 'Documents')
    await mkdir(join(victim, 'nested'), { recursive: true })
    await writeFile(join(victim, 'nested', 'taxes.txt'), 'important')

    // dataRoot() is dir, so '../../Documents' relative to attachments/ is exactly this folder
    await expect(clearAttachments('../../Documents')).rejects.toThrow(/Not a session id/)
    expect(await readdir(join(victim, 'nested'))).toEqual(['taxes.txt'])
  })

  it('writing: cannot create a file outside the attachments root', async () => {
    const outside = join(dir, 'LaunchAgents')
    await expect(
      saveAttachment('../../LaunchAgents', 'x.plist', 'text/plain', Buffer.from('pwned').toString('base64')),
    ).rejects.toThrow(/Not a session id/)
    await expect(readdir(outside)).rejects.toThrow()
  })

  it('an ordinary id works as expected — it saves, and deleting it makes it disappear', async () => {
    const id = randomUUID()
    const att = await saveAttachment(id, 'shot.png', 'image/png', Buffer.from('png').toString('base64'))
    expect(att.path.startsWith(join(dir, 'attachments', id) + sep)).toBe(true)
    expect(await readdir(join(dir, 'attachments', id))).toHaveLength(1)

    await clearAttachments(id)
    await expect(readdir(join(dir, 'attachments', id))).rejects.toThrow()
  })
})
