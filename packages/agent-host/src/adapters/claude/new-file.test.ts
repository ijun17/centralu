import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newFile } from './new-file.js'

/** Whether a Write makes its file, read without holding the host up (#843 review) */
let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cc-new-file-'))
  await writeFile(join(dir, 'there.txt'), 'x')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

describe('newFile', () => {
  it('says a missing path is new and an existing one is not', async () => {
    expect(await newFile(join(dir, 'missing.txt'))).toBe(true)
    expect(await newFile(join(dir, 'there.txt'))).toBe(false)
  })

  it('gives up on a check that does not answer in time, rather than waiting on a slow mount', async () => {
    const started = Date.now()
    expect(await newFile('/slow/mount/a.txt', () => new Promise(() => {}))).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('does not call a path new when it cannot be read for another reason', async () => {
    expect(await newFile('/x', () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })))).toBeUndefined()
  })
})
