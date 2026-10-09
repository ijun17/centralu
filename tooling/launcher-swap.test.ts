import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
import { swapInto } from '../packaging/npm/centralu/bin/swap.mjs'

/**
 * `centralu install` (and `centralu update`, which runs it) replacing the copy in
 * `/Applications`, run against a temporary folder.
 *
 * It used to delete the installed app first and copy the new one after, so a copy that failed
 * left the person with no app at all, from a command they ran to update it.
 */
let parent: string
let source: string
let target: string

const bundle = (dir: string, version: string) => {
  mkdirSync(join(dir, 'Contents'), { recursive: true })
  writeFileSync(join(dir, 'Contents', 'version'), version)
}
const copy = (staging: string) => cpSync(source, staging, { recursive: true })
const versionAt = (dir: string) => readFileSync(join(dir, 'Contents', 'version'), 'utf8')

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'cc-launcher-swap-'))
  source = join(parent, 'package', 'Centralu.app')
  target = join(parent, 'Applications', 'Centralu.app')
  bundle(source, 'new')
  mkdirSync(join(parent, 'Applications'))
})
afterEach(() => rmSync(parent, { recursive: true, force: true }))

describe('replacing the installed app', () => {
  it('a copy that fails leaves the old app in place, whole', () => {
    bundle(target, 'old')
    const failing = (staging: string) => {
      // Half a bundle, then the copy dies (a full disk, an interrupted ditto)
      mkdirSync(join(staging, 'Contents'), { recursive: true })
      throw new Error('ditto: No space left on device')
    }

    expect(() => swapInto(target, failing)).toThrow(/No space left/)
    expect(versionAt(target)).toBe('old')
    expect(readdirSync(join(parent, 'Applications'))).toEqual(['Centralu.app'])
  })

  it('replaces the old app and leaves nothing beside it', () => {
    bundle(target, 'old')

    expect(swapInto(target, copy, 42)).toEqual({ replaced: true, leftAt: null })
    expect(versionAt(target)).toBe('new')
    expect(readdirSync(join(parent, 'Applications'))).toEqual(['Centralu.app'])
  })

  it('installs where nothing was installed', () => {
    expect(swapInto(target, copy)).toEqual({ replaced: false, leftAt: null })
    expect(versionAt(target)).toBe('new')
    expect(readdirSync(join(parent, 'Applications'))).toEqual(['Centralu.app'])
  })

  it('clears a staging copy an earlier interrupted install left behind', () => {
    bundle(target, 'old')
    bundle(`${target}.new`, 'half')
    writeFileSync(join(`${target}.new`, 'stray'), '')

    swapInto(target, copy)
    expect(versionAt(target)).toBe('new')
    expect(existsSync(join(target, 'stray'))).toBe(false)
    expect(readdirSync(join(parent, 'Applications'))).toEqual(['Centralu.app'])
  })
})
