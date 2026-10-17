import { spawnSync } from 'node:child_process'
import { mkdirSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IMPORT_LIMITS, stageLocal } from './imports.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * A link inside the folder being imported is skipped, not refused. It is told from a link that leaves the folder by
 * comparing real paths, and those must be spelled the same way: on Windows the JS `realpathSync` keeps a short name
 * (`C:\Users\RUNNER~1\…`, which is what `%TEMP%` is on CI) that a link's target does not have, and an internal link
 * was refused as "outside the folder" (#976; the same bug #849 fixed for the path guard).
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(removeTree))
})

/** A folder with a manifest-less app tree: `real/a.txt`, and `link` pointing at `real` (a junction on Windows, which needs no privilege) */
function folderWithInternalLink(): string {
  const long = tempRoot('cc-import-link-long-folder-name-')
  dirs.push(long)
  mkdirSync(join(long, 'real'))
  writeFileSync(join(long, 'real', 'a.txt'), 'x')
  symlinkSync(join(long, 'real'), join(long, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  return long
}

describe('a link inside the folder being imported', () => {
  it('is skipped as a link', () => {
    const src = folderWithInternalLink()
    const out = stageLocal(src, join(src, '..', `${src.split(/[\\/]/).pop()}-staged`), IMPORT_LIMITS)
    dirs.push(join(src, '..', `${src.split(/[\\/]/).pop()}-staged`))
    expect(out.skipped).toContainEqual({ path: 'link', why: 'link' })
    expect(out.files.map((f) => f.path)).toEqual(['real/a.txt'])
  })

  // `canonicalPath` makes up a path for one that is missing, so a link to nothing has to be told apart before it (a junction on Windows)
  it('that points at nothing is skipped as a link to nothing', () => {
    const src = folderWithInternalLink()
    mkdirSync(join(src, 'gone'))
    symlinkSync(join(src, 'gone'), join(src, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    rmdirSync(join(src, 'gone'))
    const dest = `${src}-staged`
    dirs.push(dest)
    const out = stageLocal(src, dest, IMPORT_LIMITS)
    expect(out.skipped).toContainEqual({ path: 'dangling', why: 'link to nothing' })
    expect(out.skipped).toContainEqual({ path: 'link', why: 'link' })
  })

  it.skipIf(process.platform !== 'win32')('is still skipped when the folder is named by its Windows short name', () => {
    const long = folderWithInternalLink()
    const short = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], {
      windowsVerbatimArguments: true,
    }).stdout.toString().trim()
    expect(short, 'this volume makes short names').not.toBe(long)
    const dest = `${long}-staged`
    dirs.push(dest)
    const out = stageLocal(short, dest, IMPORT_LIMITS)
    expect(out.skipped).toContainEqual({ path: 'link', why: 'link' })
  })
})
