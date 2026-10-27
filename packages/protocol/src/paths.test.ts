import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  folderNameError,
  gitRemoteKey,
  gitSourceError,
  osPathBaseName,
  repoNameOf,
  wireBaseName,
  wireJoin,
  wireParent,
  wireSegments,
} from './paths.js'

/** A repository a new project is cloned from (#515): https, ssh and scp-like only */
describe('a clone source', () => {
  it('takes https, ssh:// and user@host:path addresses', () => {
    for (const ok of [
      'https://github.com/me/app.git',
      'https://me@gitlab.example.com/group/sub/app',
      'ssh://git@host:2222/me/app.git',
      'git@github.com:me/app.git',
      'host.example:repos/app',
    ]) {
      expect(gitSourceError(ok), ok).toBeNull()
    }
  })

  it('refuses transport helpers, file://, local paths, plain git:// and http://, options and passwords', () => {
    for (const bad of [
      '',
      'ext::sh -c touch% /tmp/x',
      'fd::17',
      'file:///srv/repo.git',
      '/srv/repo.git',
      './repo',
      '~/repo',
      'C:\\repos\\app',
      'C:/repos/app',
      '\\\\server\\share\\repo',
      'git://host/app.git',
      'http://host/app.git',
      '-uhttps://host/app.git',
      'git@host:-oProxyCommand=x',
      'ssh://-oProxyCommand=x/repo.git',
      'https://me:secret@host/app.git',
      'https://host/',
      'https://host/a b.git',
      `https://host/${'a'.repeat(2048)}`,
    ]) {
      expect(gitSourceError(bad), bad).not.toBeNull()
    }
  })

  it('names the folder after the repository', () => {
    expect(repoNameOf('https://github.com/me/app.git')).toBe('app')
    expect(repoNameOf('https://github.com/me/app/')).toBe('app')
    expect(repoNameOf('git@github.com:me/app.git')).toBe('app')
    expect(repoNameOf('host:app.git')).toBe('app')
    expect(repoNameOf('ssh://git@host:22/team/site.GIT')).toBe('site')
  })
})

/** Which repository a remote names (#1038): every way to write one address is one key, two repositories are two */
describe('a remote address as one repository', () => {
  it('reads https, ssh and scp-like addresses of one repository as the same', () => {
    const one = [
      'https://GitHub.com/me/app.git',
      'https://github.com/me/app/',
      'https://user@github.com:443/me/app',
      'https://user:ghp_secret@github.com/me/app.git',
      'ssh://git@github.com/me/app.git',
      'ssh://git@github.com:22/me/app',
      'ssh://git@github.com/~/me/app',
      'git@github.com:me/app.git',
      'github.com:me/app',
      '  git@github.com:me/app.git/  ',
    ]
    for (const url of one) expect(gitRemoteKey(url), url).toBe('github.com/me/app')
  })

  it('tells two repositories, two hosts, or two cases of a path apart', () => {
    expect(gitRemoteKey('git@github.com:me/app.git')).not.toBe(gitRemoteKey('git@github.com:me/app-two.git'))
    expect(gitRemoteKey('git@github.com:me/app.git')).not.toBe(gitRemoteKey('git@gitlab.com:me/app.git'))
    expect(gitRemoteKey('https://github.com/me/app')).not.toBe(gitRemoteKey('https://github.com/you/app'))
    // Only the host is lowercased: a host may tell these apart
    expect(gitRemoteKey('https://git.example/Team/App')).toBe('git.example/Team/App')
    expect(gitRemoteKey('https://git.example/Team/App')).not.toBe(
      gitRemoteKey('https://git.example/team/app'),
    )
  })

  // A folder names a repository only on its own computer (#1038 review): two machines' local remotes are never one
  it('has no key for a local path, a file:// address, or nothing', () => {
    for (const url of [
      'C:\\repos\\app.git',
      '/srv/git/app.git',
      '../app.git',
      './app',
      'file:///srv/git/app.git',
      '\\\\server\\share\\app',
      '   ',
    ]) {
      expect(gitRemoteKey(url), url).toBeNull()
    }
  })
})

/** A new project's folder name (#515): one segment, and nothing a Windows checkout of it would choke on */
describe('a new folder name', () => {
  it('is one segment: no separator, no climbing, not empty', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../up', '/abs', 'x\u0000y', 'tab\there']) {
      expect(folderNameError(bad, false), JSON.stringify(bad)).not.toBeNull()
    }
    expect(folderNameError('x'.repeat(256), false)).toMatch(/too long/)
    // Counted in bytes: 128 two-byte letters are 256 bytes
    expect(folderNameError('é'.repeat(128), false)).toMatch(/too long/)
  })

  it('refuses the reserved Windows device names on every machine, with or without an extension', () => {
    for (const bad of [
      'CON',
      'con',
      'nul',
      'Aux.txt',
      'COM1',
      'lpt9',
      'com¹',
      'CONIN$',
      'conout$',
      'nul .txt',
      'Aux  .c',
      'com1 ',
    ]) {
      expect(folderNameError(bad, false), bad).toMatch(/Windows/)
      expect(folderNameError(bad, true), bad).toMatch(/Windows/)
    }
    expect(folderNameError('console', false)).toBeNull()
    expect(folderNameError('conin', false)).toBeNull()
    expect(folderNameError('console .txt', false)).toBeNull()
    expect(folderNameError('com10', false)).toBeNull()
  })

  it('refuses what only Windows forbids only where the folder is made on Windows', () => {
    for (const bad of ['end.', 'end ', 'a:b', 'a?b', 'a*b', 'a|b', 'a<b', 'a"b']) {
      expect(folderNameError(bad, true), bad).not.toBeNull()
      expect(folderNameError(bad, false), bad).toBeNull()
    }
  })

  it('takes an ordinary name, a dotted one and one in another script', () => {
    for (const ok of ['game', 'my-site', '.config-like', 'v1.2', 'Café Écrit']) {
      expect(folderNameError(ok, true), ok).toBeNull()
    }
  })
})

/**
 * The wire encoding (issue #47).
 *
 * These pin the wire helpers against `node:path`, which is what the host reaches for once a path
 * stops being a wire path and becomes a place on a disk. Pinning both flavours — `posix` and
 * `win32` — is the point: the running machine is only ever one of them, so the disagreement that
 * matters is the one this file can see and the machine cannot.
 */

describe('wire paths are POSIX', () => {
  it('the root is the empty part, and it contributes no separator', () => {
    // `/a.ts` would be absolute, and every check downstream refuses those — the bug would read
    // as "the root folder is the one place you cannot drop a file"
    expect(wireJoin('', 'a.ts')).toBe('a.ts')
    expect(wireJoin('sub', 'a.ts')).toBe('sub/a.ts')
    expect(wireJoin('sub', 'deep', 'a.ts')).toBe('sub/deep/a.ts')
  })

  it('the parent is everything before the last separator, and the root for a path with none', () => {
    expect(wireParent('src/app/a.ts')).toBe('src/app')
    expect(wireParent('src/a.ts')).toBe('src')
    expect(wireParent('a.ts')).toBe('')
    expect(wireParent('')).toBe('')
    // A folder is told apart from a file by the entry, not by a trailing separator
    expect(wireParent('src/app')).toBe('src')
  })

  it('the base name is the last segment, trailing separator or not', () => {
    expect(wireBaseName('sub/a.ts')).toBe('a.ts')
    expect(wireBaseName('sub/')).toBe('sub')
    expect(wireBaseName('a.ts')).toBe('a.ts')
    expect(wireBaseName('')).toBe('')
    expect(wireBaseName('/')).toBe('')
  })

  it('it answers what node:path answers, on the platform the wire is spelled for', () => {
    for (const p of ['sub/a.ts', 'sub/deep/a.ts', 'a.ts', 'sub/.gitignore']) {
      expect(wireBaseName(p)).toBe(posix.basename(p))
    }
  })

  /**
   * `\` is an ordinary character in a file name on the machines this runs on today, so a wire
   * path can legitimately contain one and it must survive intact. The host is where that stops
   * being true — `baseName` there asks the platform whether the result is still a name.
   */
  it('a backslash is a character, not a separator', () => {
    expect(wireBaseName('sub/a\\b.txt')).toBe('a\\b.txt')
    expect(wireSegments('a\\b/c.ts')).toEqual(['a\\b', 'c.ts'])
  })

  it('segments keep the empty ones, so "absolute" stays visible', () => {
    expect(wireSegments('a/../b')).toEqual(['a', '..', 'b'])
    expect(wireSegments('/a')).toEqual(['', 'a'])
    expect(wireSegments('a//b')).toEqual(['a', '', 'b'])
  })
})

describe('native paths are read under either separator', () => {
  it('matches node:path for a Windows directory', () => {
    const dir = 'C:\\Users\\me\\proj'
    expect(osPathBaseName(dir)).toBe(win32.basename(dir))
    expect(osPathBaseName(dir)).toBe('proj')
    // …which is exactly what reading only `/` could not do: the whole string comes back as one
    // segment, and a project ends up named after its full path
    expect(posix.basename(dir)).toBe(dir)
  })

  it('matches node:path for a POSIX directory', () => {
    for (const dir of ['/Users/me/proj', '/tmp/alpha', '/opt/x/y']) {
      expect(osPathBaseName(dir)).toBe(posix.basename(dir))
    }
  })

  it('a trailing separator does not empty the name', () => {
    expect(osPathBaseName('/tmp/alpha/')).toBe('alpha')
    expect(osPathBaseName('C:\\Users\\me\\proj\\')).toBe('proj')
  })
})
