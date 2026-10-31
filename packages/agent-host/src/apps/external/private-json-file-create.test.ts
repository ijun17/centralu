import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { PrivateJsonFile } from './private-json-file.js'

vi.mock('node:crypto', async (original) => ({ ...(await original<typeof import('node:crypto')>()), randomBytes: () => Buffer.from([1, 2, 3, 4]) }))

let dir = ''
beforeEach(() => {
  dir = tempRoot('cc-private-create-')
  mkdirSync(dir, { recursive: true })
})
afterEach(async () => removeTree(dir))

const open = (name: string) =>
  new PrivateJsonFile<Record<string, number>>(join(dir, name), { label: 'test file', empty: () => ({}), valid: (d): d is Record<string, number> => typeof d === 'object', lost: '' })

describe('PrivateJsonFile.create', () => {
  it('answers false for a file that is there, and leaves it as it is', () => {
    writeFileSync(join(dir, 'a.json'), '{"kept":1}')
    expect(open('a.json').create({ new: 2 })).toBe(false)
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('{"kept":1}')
  })

  it('throws when its temp name is taken, as it did before the write paths were shared: no file was written', () => {
    writeFileSync(join(dir, `b.json.${process.pid}-01020304.tmp`), 'someone else\'s')
    expect(() => open('b.json').create({ new: 2 })).toThrow(/EEXIST/)
    expect(() => readFileSync(join(dir, 'b.json'))).toThrow(/ENOENT/)
  })
})
