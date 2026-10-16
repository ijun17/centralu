import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { folderFingerprint, walkCode } from './fingerprint.js'
import { IMPORT_LIMITS, listAppFiles, stageLocal } from './imports.js'
import { AppVersions } from './versions.js'

/**
 * Every reader of an app folder walks it the same way (`folder-walk.ts`): what an import copies is
 * what the fingerprint measures and what a version keeps, as deep as an import may nest folders.
 */

let root = ''
let app = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-walk-')))
  app = join(root, 'app')
  mkdirSync(app)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(app, rel)), { recursive: true })
  writeFileSync(join(app, rel), text)
}

/** A file in the 12th nested folder — deeper than the fingerprint used to look (8), within what an import accepts (16) */
const DEEP = 'a/b/c/d/e/f/g/h/i/j/k/l/deep.mjs'

const measured = (dir: string) => {
  const files: string[] = []
  walkCode(dir, { unreadable: () => {}, dir: () => {}, more: () => {}, file: (r) => void files.push(r) })
  return files
}

describe('one walk over an app folder', () => {
  it('an edit deep inside the folder changes the fingerprint, so it restarts the app', () => {
    write('server.mjs', '// server')
    write(DEEP, 'export const v = 1')
    const before = folderFingerprint(app)
    write(DEEP, 'export const v = 2')
    expect(folderFingerprint(app)).not.toBe(before)
  })

  it('a version keeps and restores a deep file', () => {
    write('server.mjs', '// server')
    write(DEEP, 'export const v = 1')
    const versions = new AppVersions(join(root, 'versions'))
    const snap = versions.capture('app', app, 'started')!
    unlinkSync(join(app, DEEP))
    versions.restore('app', snap.id, app)
    expect(readFileSync(join(app, DEEP), 'utf8')).toBe('export const v = 1')
    expect(folderFingerprint(app)).toBe(snap.stamp)
  })

  it('restoring a version an older build captured (8 folders deep) leaves alone what lies deeper — the version never held it', () => {
    write('server.mjs', '// v1')
    const versions = new AppVersions(join(root, 'versions'))
    const snap = versions.capture('app', app, 'started')!
    // What an older build wrote: no depth recorded
    const meta = join(root, 'versions', 'app', snap.id, 'meta.json')
    const { depth: _depth, ...old } = JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>
    writeFileSync(meta, JSON.stringify(old))
    write('server.mjs', '// v2')
    write(DEEP, 'export const v = 1')
    write('a/b/c/d/e/f/g/shallow-extra.mjs', 'gone after the restore')

    versions.restore('app', snap.id, app)
    expect(readFileSync(join(app, 'server.mjs'), 'utf8')).toBe('// v1')
    expect(readFileSync(join(app, DEEP), 'utf8')).toBe('export const v = 1')
    // Within the depth the version looked at, a file it did not hold is still removed
    expect(existsSync(join(app, 'a/b/c/d/e/f/g/shallow-extra.mjs'))).toBe(false)
  })

  it('restoring a version captured at the shared depth removes a deep file the version did not hold', () => {
    write('server.mjs', '// v1')
    const versions = new AppVersions(join(root, 'versions'))
    const snap = versions.capture('app', app, 'started')!
    expect(snap.depth).toBe(16)
    write(DEEP, 'export const v = 1')
    versions.restore('app', snap.id, app)
    expect(existsSync(join(app, DEEP))).toBe(false)
    expect(folderFingerprint(app)).toBe(snap.stamp)
  })

  it('an import copies what the fingerprint measures, as deep, plus the node_modules it brings — never a dot-name or __MACOSX', () => {
    write('centralu.app.json', '{}')
    write('server.mjs', '// server')
    write('ui/index.html', '<p>hi</p>')
    write(DEEP, 'export const v = 1')
    write('.env', 'SECRET=1')
    write('__MACOSX/._server.mjs', '')
    write('node_modules/dep/index.js', '// installed')
    write('lib/node_modules/nested/index.js', '// installed')

    const staged = stageLocal(app, join(root, 'staged'), IMPORT_LIMITS)
    const code = ['a/b/c/d/e/f/g/h/i/j/k/l/deep.mjs', 'centralu.app.json', 'server.mjs', 'ui/index.html']
    const deps = ['lib/node_modules/nested/index.js', 'node_modules/dep/index.js']
    // The fingerprint and a version measure the app's own code, as deep as an import nests it
    expect(measured(app)).toEqual(code)
    // An import moves the installed packages too, as it always did
    expect(staged.files.map((f) => f.path).sort()).toEqual([...code, ...deps].sort())
    expect(readFileSync(join(root, 'staged', 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('// installed')
    expect(measured(join(root, 'staged'))).toEqual(code)
    expect(staged.skipped).toEqual([
      { path: '.env', why: 'hidden' },
      { path: '__MACOSX/', why: 'hidden' },
    ])
  })

  it("the re-review of an imported app lists the node_modules files it has on disk, never as 'not copied'", () => {
    write('centralu.app.json', '{}')
    write('server.mjs', '// server')
    write('node_modules/dep/index.js', '// installed')
    write('.env', 'SECRET=1')
    const listed = listAppFiles(app, IMPORT_LIMITS)
    expect(listed.files.map((f) => f.path)).toEqual(['centralu.app.json', 'node_modules/dep/index.js', 'server.mjs'])
    expect(listed.skipped).toEqual([{ path: '.env', why: 'hidden' }])
  })
})
