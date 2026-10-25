import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { treeBytes } from './entry-sizes.js'
import { itSymlink } from '../link.test-helpers.js'

let dir = ''

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tree-bytes-')))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})


/*
 * #849 review: one folder of a million files queued a million lstat calls at once. The walk measures in batches,
 * checks its deadline between them, and gives up past a number of entries, leaving that entry without a size.
 */
describe('the file system walk that sizes an ignored entry', () => {
  it('adds up the bytes, and has no size past its entry cap or its deadline', async () => {
    mkdirSync(join(dir, 'many'))
    for (let i = 0; i < 600; i++) writeFileSync(join(dir, 'many', `${i}.bin`), Buffer.alloc(10))
    expect(await treeBytes(join(dir, 'many'), Date.now() + 60_000)).toBe(6000)
    expect(await treeBytes(join(dir, 'many'), Date.now() + 60_000, 500)).toBeNull()
    expect(await treeBytes(join(dir, 'many'), Date.now() - 1)).toBeNull()
  })

  it('has no size for what is not there, and none of a deadline or a cap when given none (the data folders)', async () => {
    expect(await treeBytes(join(dir, 'gone'), Date.now() + 60_000)).toBeNull()
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'one.bin'), Buffer.alloc(7))
    writeFileSync(join(dir, 'a', 'b', 'two.bin'), Buffer.alloc(5))
    expect(await treeBytes(join(dir, 'a'), Infinity, Infinity)).toBe(12)
    expect(await treeBytes(join(dir, 'a', 'one.bin'), Infinity, Infinity)).toBe(7)
  })

  /*
   * The walk and the data folders' sizing (`dataBytes`) are one function since #850 item 19. The data folders already
   * counted a link given as the path itself as nothing; the walk counted the link's own few bytes.
   */
  itSymlink('a link counts for nothing and is not followed, the path itself included', async () => {
    const outside = join(dir, 'outside.bin')
    writeFileSync(outside, Buffer.alloc(10_000))
    const tree = join(dir, 'tree')
    mkdirSync(tree)
    writeFileSync(join(tree, 'a.bin'), Buffer.alloc(100))
    symlinkSync(outside, join(tree, 'out'))
    symlinkSync(join(dir, 'nowhere'), join(tree, 'dangling'))
    symlinkSync(outside, join(dir, 'link'))
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'))

    expect(await treeBytes(tree, Date.now() + 60_000)).toBe(100)
    expect(await treeBytes(join(dir, 'link'), Date.now() + 60_000)).toBe(0)
    expect(await treeBytes(join(dir, 'dangling'), Date.now() + 60_000)).toBe(0)
  })
})
