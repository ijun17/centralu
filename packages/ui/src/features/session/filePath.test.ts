import { describe, expect, it } from 'vitest'
import { isImageLinkPath, localLinkPath, parseFileRef, parseMarkdownFileRef, titlePieces } from './filePath.js'

const ROOT = '/Users/me/proj'

describe('parseFileRef — what an agent said that we are willing to open', () => {
  it('takes a project-relative path (ASCII and Unicode)', () => {
    expect(parseFileRef('packages/ui/src/store/store.ts', ROOT)).toEqual({
      path: 'packages/ui/src/store/store.ts',
      line: null,
    })
    expect(parseFileRef('docs/한글-가이드.md:5', ROOT)).toEqual({
      path: 'docs/한글-가이드.md',
      line: 5,
    })
    expect(parseFileRef('docs/cafe\u0301.md', ROOT)).toEqual({
      path: 'docs/cafe\u0301.md',
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

  it('refuses everything when the session has no project (the Assistant)', () => {
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

describe('parseMarkdownFileRef — explicit Markdown links to files inside the project', () => {
  it('accepts file:// and file://localhost/ URLs with #L10-L20 anchors', () => {
    expect(parseMarkdownFileRef(`file://${ROOT}/src/a.ts`, ROOT)).toEqual({ path: 'src/a.ts', line: null })
    expect(parseMarkdownFileRef(`file://${ROOT}/src/a.ts#L42`, ROOT)).toEqual({ path: 'src/a.ts', line: 42 })
    expect(parseMarkdownFileRef(`file://${ROOT}/src/a.ts#L10-L20`, ROOT)).toEqual({ path: 'src/a.ts', line: 10 })
    expect(parseMarkdownFileRef(`file://localhost${ROOT}/src/a.ts#L7C3`, ROOT)).toEqual({ path: 'src/a.ts', line: 7 })
  })

  it('decodes percent-encoded spaces and Korean characters inside the project', () => {
    expect(parseMarkdownFileRef(`file://${ROOT}/docs/%ED%95%9C%EA%B8%80%20%EA%B0%80%EC%9D%B4%EB%93%9C.md#L5`, ROOT)).toEqual({
      path: 'docs/한글 가이드.md',
      line: 5,
    })
    expect(parseMarkdownFileRef(`${ROOT}/docs/한글 가이드.md:12:4`, ROOT)).toEqual({
      path: 'docs/한글 가이드.md',
      line: 12,
    })
  })

  it('normalizes Windows paths, file:///C:/ URLs, and percent-encoded backslashes (%5C) against a Windows project root', () => {
    const WIN_ROOT = 'C:\\Users\\me\\proj'
    expect(parseMarkdownFileRef('file:///C:/Users/me/proj/src/a.ts#L9', WIN_ROOT)).toEqual({ path: 'src/a.ts', line: 9 })
    expect(parseMarkdownFileRef('file:///C:%5CUsers%5Cme%5Cproj%5Csrc%5Ca.ts', WIN_ROOT)).toEqual({ path: 'src/a.ts', line: null })
    expect(parseMarkdownFileRef('file://localhost/C:/Users/me/proj/src/a.ts', WIN_ROOT)).toEqual({ path: 'src/a.ts', line: null })
    expect(parseMarkdownFileRef('c:\\users\\me\\proj\\src\\a.ts:3', WIN_ROOT)).toEqual({ path: 'src/a.ts', line: 3 })
  })

  it('refuses home paths (~/), UNC/off-machine hosts, drive-relative paths, traversal, outside-project paths, directories, and non-file schemes', () => {
    expect(parseMarkdownFileRef('~/Downloads/상점용-PNG.zip', ROOT)).toBeNull()
    expect(parseMarkdownFileRef('~\\Downloads\\out.zip', 'C:\\Users\\me\\proj')).toBeNull()
    expect(parseMarkdownFileRef('C:foo.ts', 'C:\\Users\\me\\proj')).toBeNull()
    expect(parseMarkdownFileRef('\\\\server\\share\\a.ts', ROOT)).toBeNull()
    expect(parseMarkdownFileRef('file://evil.example/Users/me/proj/src/a.ts', ROOT)).toBeNull()
    expect(parseMarkdownFileRef('file:////server/share/a.ts', ROOT)).toBeNull()
    expect(parseMarkdownFileRef('https://example.com/a.ts', ROOT)).toBeNull()
    expect(parseMarkdownFileRef('javascript:alert(1)', ROOT)).toBeNull()
    expect(parseMarkdownFileRef('../other/a.ts', ROOT)).toBeNull()
    expect(parseMarkdownFileRef('/Users/me/Downloads/미리보기.png', ROOT)).toBeNull()
    expect(parseMarkdownFileRef(`${ROOT}/src`, ROOT)).toBeNull()
    expect(parseMarkdownFileRef('#section-1', ROOT)).toBeNull()
    expect(parseMarkdownFileRef(`file://${ROOT}/src/a.ts`, null)).toBeNull()
  })
})

describe('localLinkPath — local file/folder links outside or without a project', () => {
  it('decodes non-file paths and preserves file:// URLs raw so %23/%3F/%25/%2F are never corrupted before fileURLToPath', () => {
    expect(localLinkPath('/Users/ijun17/Downloads/자동사냥-배속-배너/미리보기.png')).toBe(
      '/Users/ijun17/Downloads/자동사냥-배속-배너/미리보기.png',
    )
    expect(localLinkPath('/Users/ijun17/Downloads/%EB%AF%B8%EB%A6%AC%EB%B3%B4%EA%B8%B0.png')).toBe(
      '/Users/ijun17/Downloads/미리보기.png',
    )
    expect(localLinkPath('~/Downloads/상점용-PNG.zip')).toBe('~/Downloads/상점용-PNG.zip')
    expect(localLinkPath('file:///Users/me/Downloads/%EC%82%AC%EC%A7%84%20%231.png')).toBe(
      'file:///Users/me/Downloads/%EC%82%AC%EC%A7%84%20%231.png',
    )
    expect(localLinkPath('file://localhost/Users/me/Downloads/folder')).toBe('file://localhost/Users/me/Downloads/folder')
    expect(localLinkPath('C:\\Users\\me\\Downloads\\out.zip')).toBe('C:\\Users\\me\\Downloads\\out.zip')
    expect(localLinkPath('../exports/report.pdf')).toBe('../exports/report.pdf')
  })

  it('refuses web/mail/unsafe schemes, off-machine file:// hosts, UNC/protocol-relative/encoded smuggling, bare dotfiles, fragments, and bare words', () => {
    expect(localLinkPath('https://example.com/a.png')).toBeNull()
    expect(localLinkPath('mailto:me@example.com')).toBeNull()
    expect(localLinkPath('javascript:alert(1)')).toBeNull()
    expect(localLinkPath('javascript%3Afoo/bar')).toBeNull()
    expect(localLinkPath('data:image/png;base64,AAA')).toBeNull()
    expect(localLinkPath('file://evil.example/share/a.png')).toBeNull()
    expect(localLinkPath('file:////server/share/a.png')).toBeNull()
    expect(localLinkPath('file://localhost//server/share/a.png')).toBeNull()
    expect(localLinkPath('file:///%2Fserver/share/a.png')).toBeNull()
    expect(localLinkPath('//server/share/a.png')).toBeNull()
    expect(localLinkPath('\\\\server\\share\\a.png')).toBeNull()
    expect(localLinkPath('%2F%2Fserver%2Fshare%2Fa.txt')).toBeNull()
    expect(localLinkPath('.env')).toBeNull()
    expect(localLinkPath('.ts')).toBeNull()
    expect(localLinkPath('#heading')).toBeNull()
    expect(localLinkPath('?tab=1')).toBeNull()
    expect(localLinkPath('plainword')).toBeNull()
    expect(localLinkPath('/tmp/bad%00.png')).toBeNull()
  })
})

describe('isImageLinkPath', () => {
  it('matches raster formats supported by messages.image even with line anchors', () => {
    expect(isImageLinkPath('/Users/me/Downloads/미리보기.png')).toBe(true)
    expect(isImageLinkPath('file:///tmp/photo.JPEG#L1')).toBe(true)
    expect(isImageLinkPath('/tmp/photo.png#L1-L2')).toBe(true)
    expect(isImageLinkPath('/tmp/anim.webp:1')).toBe(true)
    expect(isImageLinkPath('/tmp/clip.gif')).toBe(true)
  })

  it('excludes archives, SVGs, code files, non-line fragments on plain paths, and folders', () => {
    expect(isImageLinkPath('/Users/me/Downloads/상점용-PNG.zip')).toBe(false)
    expect(isImageLinkPath('/tmp/photo.png#preview')).toBe(false)
    expect(isImageLinkPath('/tmp/icon.svg')).toBe(false)
    expect(isImageLinkPath('/tmp/notes.md')).toBe(false)
    expect(isImageLinkPath('/Users/me/Downloads/folder')).toBe(false)
  })
})

