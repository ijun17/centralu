import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Plain JavaScript, run directly by node in build.yml.
import { compareVersions, minosOf, minosProblems } from '../scripts/macos-minos.mjs'

const build = (minos: string) => `Load command 8\n      cmd LC_UUID\n  cmdsize 24\nLoad command 9\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos ${minos}\n      sdk 15.5\n   ntools 1\n`
const old = (version: string) => `Load command 9\n      cmd LC_VERSION_MIN_MACOSX\n  cmdsize 16\n  version ${version}\n      sdk 10.15\n`

describe('the oldest macOS a Mach-O file asks for', () => {
  it('reads the minimum from either load command, once per architecture of a fat file', () => {
    expect(minosOf(build('11.0'))).toEqual(['11.0'])
    expect(minosOf(old('10.13'))).toEqual(['10.13'])
    expect(minosOf(`${build('11.0')}${build('13.5')}`)).toEqual(['11.0', '13.5'])
    expect(minosOf('Load command 1\n      cmd LC_SEGMENT_64\n    version 1\n')).toEqual([])
  })

  it('compares dotted versions by number, so 11.0 is 11.0.0 and 11.10 is after 11.2', () => {
    expect(compareVersions('11.0', '11.0.0')).toBe(0)
    expect(compareVersions('11.10', '11.2')).toBeGreaterThan(0)
    expect(compareVersions('10.13', '11.0')).toBeLessThan(0)
  })
})

describe('the Mach-O files under a folder', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
  const bundle = (files: Record<string, string | Buffer>) => {
    const dir = mkdtempSync(join(tmpdir(), 'minos-'))
    dirs.push(dir)
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), content)
    }
    return dir
  }
  const macho = Buffer.from('cffaedfe00000000', 'hex')
  // The fake `otool` answers by file name, so no macOS is needed
  const answers = (table: Record<string, string>) => (path: string) => table[basename(path)] ?? ''

  it('passes when every one asks for the supported macOS or less, add-ons and helpers included', () => {
    const dir = bundle({ 'Contents/MacOS/app': macho, 'Contents/Resources/host/pty.node': macho, 'Contents/Resources/host/spawn-helper': macho, 'Contents/Info.plist': 'text' })
    const otool = answers({ app: build('11.0'), 'pty.node': build('11.0'), 'spawn-helper': old('10.15') })
    expect(minosProblems(dir, { otool })).toEqual([])
  })

  it('names a file outside Contents/MacOS that needs a newer macOS', () => {
    const dir = bundle({ 'Contents/MacOS/app': macho, 'Contents/Resources/host/better_sqlite3.node': macho })
    const otool = answers({ app: build('11.0'), 'better_sqlite3.node': build('13.5') })
    expect(minosProblems(dir, { otool })).toEqual(['Contents/Resources/host/better_sqlite3.node needs macOS 13.5, the app supports 11.0'])
  })

  it('names a Mach-O file that states no minimum, and a folder with none at all', () => {
    expect(minosProblems(bundle({ 'bin/tool': macho }), { otool: () => '' })).toEqual(['bin/tool names no minimum macOS'])
    expect(minosProblems(bundle({ 'readme.txt': 'x' }), { otool: () => '' })).toHaveLength(1)
  })

  it('does not follow links, so a link out of the bundle is not read', () => {
    const dir = bundle({ 'Contents/MacOS/app': macho })
    const outside = bundle({ 'elsewhere/lib': macho })
    symlinkSync(join(outside, 'elsewhere'), join(dir, 'Contents/linked'), 'junction')
    expect(minosProblems(dir, { otool: answers({ app: build('11.0'), lib: build('15.0') }) })).toEqual([])
  })
})
