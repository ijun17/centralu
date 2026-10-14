import { describe, expect, it } from 'vitest'
import { parseFileRef, titlePieces } from './filePath.js'

const ROOT = '/Users/me/proj'

describe('parseFileRef — what an agent said that we are willing to open', () => {
  it('takes a project-relative path', () => {
    expect(parseFileRef('packages/ui/src/store/store.ts', ROOT)).toEqual({
      path: 'packages/ui/src/store/store.ts',
      line: null,
    })
  })

  it('takes a bare filename at the root', () => {
    expect(parseFileRef('package.json', ROOT)).toEqual({ path: 'package.json', line: null })
  })

  it('reads `path:line` and `path:line:col` as a line to land on', () => {
    expect(parseFileRef('src/a.ts:298', ROOT)).toEqual({ path: 'src/a.ts', line: 298 })
    expect(parseFileRef('src/a.ts:298:12', ROOT)).toEqual({ path: 'src/a.ts', line: 298 })
  })

  it('has no line 0 — it means "no line", not the row above the first', () => {
    expect(parseFileRef('src/a.ts:0', ROOT)).toEqual({ path: 'src/a.ts', line: null })
  })

  it('turns an absolute path inside the project back into a relative one', () => {
    expect(parseFileRef(`${ROOT}/src/a.ts:5`, ROOT)).toEqual({ path: 'src/a.ts', line: 5 })
    expect(parseFileRef(`${ROOT}/src/a.ts`, `${ROOT}/`)).toEqual({ path: 'src/a.ts', line: null })
  })

  it('drops a leading ./ so the same file is never two different viewer paths', () => {
    expect(parseFileRef('./src/a.ts', ROOT)).toEqual({ path: 'src/a.ts', line: null })
  })

  it('refuses an absolute path outside the project — the viewer could only error on it', () => {
    expect(parseFileRef('/etc/passwd.txt', ROOT)).toBeNull()
    expect(parseFileRef('/Users/me/other/src/a.ts', ROOT)).toBeNull()
  })

  it('refuses everything when the session has no project (the orchestrator)', () => {
    expect(parseFileRef('src/a.ts', null)).toBeNull()
    expect(parseFileRef('/Users/me/proj/src/a.ts', null)).toBeNull()
  })

  it('leaves prose that merely contains a slash alone', () => {
    expect(parseFileRef('and/or', ROOT)).toBeNull()
    expect(parseFileRef('@tanstack/react-virtual', ROOT)).toBeNull()
    expect(parseFileRef('node:fs/promises', ROOT)).toBeNull()
    expect(parseFileRef('packages/ui/src', ROOT)).toBeNull()
  })

  it('leaves version numbers alone — an extension starts with a letter', () => {
    expect(parseFileRef('1.2.3', ROOT)).toBeNull()
    expect(parseFileRef('v0.1.0', ROOT)).toBeNull()
  })

  it('leaves URLs alone', () => {
    expect(parseFileRef('https://example.com/a.js', ROOT)).toBeNull()
  })

  it('leaves a bare extension alone — `.ts` is a file type, not a file', () => {
    expect(parseFileRef('.ts', ROOT)).toBeNull()
    expect(parseFileRef('.env', ROOT)).toBeNull()
    // …but with a directory in front of it there is nothing to confuse it with
    expect(parseFileRef('src/.gitignore', ROOT)).toEqual({ path: 'src/.gitignore', line: null })
  })

  it('leaves `..` alone — we know the project root, not what the path is relative to', () => {
    expect(parseFileRef('../shared/a.ts', ROOT)).toBeNull()
    expect(parseFileRef('src/../../etc/passwd.txt', ROOT)).toBeNull()
  })

  it('leaves anything with whitespace alone, which is how code blocks stay out', () => {
    expect(parseFileRef('src/a.ts\n', ROOT)).toBeNull()
    expect(parseFileRef('const x = 1\n', ROOT)).toBeNull()
    expect(parseFileRef('git status', ROOT)).toBeNull()
    expect(parseFileRef('rm -rf src/a.ts', ROOT)).toBeNull()
  })

  it('leaves shell and code shapes alone', () => {
    expect(parseFileRef('useState()', ROOT)).toBeNull()
    expect(parseFileRef('a.ts;rm', ROOT)).toBeNull()
    expect(parseFileRef("'src/a.ts'", ROOT)).toBeNull()
  })
})

describe('titlePieces: the files a tool card names', () => {
  it('cuts the title at an absolute path inside the project and keeps the rest as text', () => {
    expect(titlePieces(`Edit: ${ROOT}/src/a.ts`, [`${ROOT}/src/a.ts`], ROOT)).toEqual([
      { text: 'Edit: ' },
      { text: `${ROOT}/src/a.ts`, ref: { path: 'src/a.ts', line: null } },
    ])
  })

  it('links every file of a title that names several, in order', () => {
    expect(titlePieces('src/a.ts, src/b.ts', ['src/a.ts', 'src/b.ts'], ROOT)).toEqual([
      { text: 'src/a.ts', ref: { path: 'src/a.ts', line: null } },
      { text: ', ' },
      { text: 'src/b.ts', ref: { path: 'src/b.ts', line: null } },
    ])
  })

  it('leaves a file outside the project, a directory and a path the title does not hold as text', () => {
    expect(titlePieces('Read: /etc/hosts.conf', ['/etc/hosts.conf'], ROOT)).toEqual([{ text: 'Read: /etc/hosts.conf' }])
    expect(titlePieces('Read: src', ['src'], ROOT)).toEqual([{ text: 'Read: src' }])
    expect(titlePieces('Edit files', ['src/a.ts'], ROOT)).toEqual([{ text: 'Edit files' }])
  })

  it('links nothing without paths or without a project', () => {
    expect(titlePieces('Read: src/a.ts', undefined, ROOT)).toEqual([{ text: 'Read: src/a.ts' }])
    expect(titlePieces('Read: src/a.ts', ['src/a.ts'], null)).toEqual([{ text: 'Read: src/a.ts' }])
  })
})
