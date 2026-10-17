import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { changedFileCount } from '@cc/protocol'
import { join } from 'node:path'
import { GIT_DIFF_MAX_CHARS, gitWorktreeDirty, gitBranches, gitCheckout, gitCommit, gitCommitDetail, gitDiff, gitIgnoredEntries, gitStage, gitStatusFiles, gitSummary } from './git.js'
import { treeBytes } from './entry-sizes.js'
import { SLOW } from '../../../../tooling/test-timing.js'

/**
 * porcelain v2 parsing is checked against real git output — a hand-written string could
 * reproduce exactly the same mistake we made (the field count) all over again.
 */

const dirs: string[] = []
const repo = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-git-'))
  dirs.push(d)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: d })
  git('init', '-q')
  git('config', 'user.email', 'test@test')
  git('config', 'user.name', 'test')
  return { d, git }
}

/**
 * Records the arguments git **actually received** — a shim is put ahead of it on PATH, which
 * passes everything through to the real git.
 *
 * Why execFile itself is not intercepted: intercepting it would stop the real git from running,
 * and the same test would lose its power to check the result too. Here the real git runs
 * unchanged, and only its command line is copied.
 */
function recordGitArgv(): { calls: () => string[][]; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cc-git-argv-'))
  dirs.push(dir)
  const log = join(dir, 'argv.log')
  if (process.platform === 'win32') return recordGitArgvTrace2(log)
  const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim()
  const shim = join(dir, 'bin')
  mkdirSync(shim)
  writeFileSync(
    join(shim, 'git'),
    `#!/bin/sh\nprintf '%s\\036' "$@" >> "${log}"\nprintf '\\n' >> "${log}"\nexec "${real}" "$@"\n`,
  )
  chmodSync(join(shim, 'git'), 0o755)
  writeFileSync(log, '')

  const previousPath = process.env.PATH
  process.env.PATH = `${shim}:${previousPath ?? ''}`
  return {
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\u001e').slice(0, -1)),
    restore: () => {
      process.env.PATH = previousPath
    },
  }
}

/**
 * The same record on Windows, where no shim on PATH can stand in for git: the host spawns git by
 * its absolute path (#14), and a sh script could not be spawned anyway. Git writes the arguments it
 * received itself, one `start` event per process in its trace2 log; only the processes the host
 * started are kept, not the ones git starts under them.
 */
function recordGitArgvTrace2(log: string): { calls: () => string[][]; restore: () => void } {
  const previous = process.env.GIT_TRACE2_EVENT
  process.env.GIT_TRACE2_EVENT = log
  return {
    calls: () =>
      (existsSync(log) ? readFileSync(log, 'utf8') : '')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; sid: string; argv?: string[] })
        .filter((e) => e.event === 'start' && !e.sid.includes('/'))
        .map((e) => e.argv!.slice(1)),
    restore: () => {
      if (previous === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previous
    },
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('gitStatusFiles — porcelain v2', () => {
  /*
   * A rename (2) entry has one extra field before the path (R100, etc.).
   * Reading it at the same position as an ordinary (1) entry turns the path into
   * "R100 new-name" — a file that does not exist — and staging failed silently.
   */
  it('a renamed file comes out under its new name (the score field does not leak into the path)', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'old.txt'), 'the content needs to be long enough for git to recognize it as a rename\n'.repeat(5))
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    // Rename to a name with a space — this also checks whether path reconstruction (join) breaks
    git('mv', 'old.txt', 'new name.txt')

    const files = await gitStatusFiles(d)
    expect(files).toEqual([{ path: 'new name.txt', staged: true, status: 'R' }])
    // The original name (old.txt) must not leak out as a separate entry (under -z it arrives as the next NUL token)
    expect(files.some((f) => f.path.includes('old.txt'))).toBe(false)
    // Staging only succeeds if the parsed path is a real file — this is the exact spot that used to fail silently
    await expect(gitStage(d, files.map((f) => f.path))).resolves.toBeUndefined()
  })

  it('an ordinary change (1) comes out unchanged', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'a.txt'), 'v1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(d, 'a.txt'), 'v2\n')

    const files = await gitStatusFiles(d)
    expect(files).toEqual([{ path: 'a.txt', staged: false, status: 'M' }])
  })
})

/**
 * A fake git on PATH that answers `status` with `script` and passes every other call to the real one (POSIX only:
 * on Windows the host spawns git by its absolute path).
 */
function fakeStatus(script: string): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'cc-git-status-'))
  dirs.push(dir)
  const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim()
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = status ]; then ${script}; fi; done\nexec "${real}" "$@"\n`)
  chmodSync(join(dir, 'git'), 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${dir}:${previous ?? ''}`
  return () => {
    process.env.PATH = previous
  }
}

describe('the change summary on a large or slow tree (#850 review of item 10)', () => {
  const posix = process.platform !== 'win32'

  it.skipIf(!posix)('counts an endless list of untracked files up to its cap, still a repository', async () => {
    const { d, git } = repo()
    git('commit', '-q', '--allow-empty', '-m', 'init')
    // More than the 32 MB a buffered read holds: it used to overflow and read as "not a repository"
    const restore = fakeStatus(
      `printf '# branch.oid 0\\0# branch.head main\\0'; i=0; while :; do printf '? new/%s-%0200d\\0' $i 0; i=$((i+1)); done`,
    )
    try {
      const summary = await gitSummary(d, { trusted: true }, { cap: 1000 })
      expect(summary).toEqual({ isRepo: true, branch: 'main', changedFiles: 1000, more: true })
    } finally {
      restore()
    }
  }, 60_000 * SLOW)

  it.skipIf(!posix)('a status that does not answer in time is unknown, not "not a repository"', async () => {
    const { d, git } = repo()
    git('commit', '-q', '--allow-empty', '-m', 'init')
    const restore = fakeStatus('exec sleep 30')
    try {
      const summary = await gitSummary(d, { trusted: true }, { timeoutMs: 500 })
      expect(summary.isRepo).toBe(true)
      expect(summary.unknown).toBe(true)
      // A worktree whose count is unknown is not called clean: removal asks first
      expect((await gitWorktreeDirty(d, { trusted: true }, { timeoutMs: 500 })).dirty).toBe(true)
    } finally {
      restore()
    }
  }, 30_000 * SLOW)

  it('stops at the cap with real git, and says there is more', async () => {
    const { d } = repo()
    mkdirSync(join(d, 'many'))
    for (let i = 0; i < 30; i++) writeFileSync(join(d, 'many', `f${i}.ts`), '')
    expect(await gitSummary(d, {}, { cap: 10 })).toMatchObject({ isRepo: true, changedFiles: 10, more: true })
    expect((await gitSummary(d, {}, { cap: 30 })).more).toBeUndefined()
  })

  it.skipIf(!posix)('reads git in English: a translated "not a git repository" is still no repository', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-not-git-'))
    dirs.push(d)
    // What git prints under a Korean locale, and the English it prints under C or C.UTF-8
    const restore = fakeStatus(
      `if [ "\${LC_ALL%%.*}" = C ]; then echo 'fatal: not a git repository (or any of the parent directories): .git' >&2; else echo 'fatal: 깃 저장소가 아닙니다' >&2; fi; exit 128`,
    )
    const previous = process.env.LC_ALL
    process.env.LC_ALL = 'ko_KR.UTF-8'
    try {
      expect(await gitSummary(d, { trusted: true })).toEqual({ isRepo: false, branch: '', changedFiles: 0 })
    } finally {
      if (previous === undefined) delete process.env.LC_ALL
      else process.env.LC_ALL = previous
      restore()
    }
  })

  it.skipIf(!posix)('takes no optional lock: the agent\'s own git add or commit is not refused for index.lock', async () => {
    const { d, git } = repo()
    git('commit', '-q', '--allow-empty', '-m', 'init')
    const seen = join(d, '..', `${d.split('/').pop()}-env`)
    dirs.push(seen)
    const restore = fakeStatus(`echo "$GIT_OPTIONAL_LOCKS" > '${seen}'; printf '# branch.head main\\0'; exit 0`)
    try {
      await gitSummary(d, { trusted: true })
      expect(readFileSync(seen, 'utf8').trim()).toBe('0')
    } finally {
      restore()
    }
  })

  it.skipIf(!posix)('ends when git ends, even if a process git started still holds its output', async () => {
    const { d, git } = repo()
    git('commit', '-q', '--allow-empty', '-m', 'init')
    // A hook or filter left running with git's stdout: the pipe stays open after git exits
    const restore = fakeStatus(`sleep 20 & printf '# branch.head main\\0? a.ts\\0'; exit 0`)
    try {
      expect(await gitSummary(d, { trusted: true })).toEqual({ isRepo: true, branch: 'main', changedFiles: 1 })
    } finally {
      restore()
    }
  }, 10_000 * SLOW)

  it.skipIf(!posix)('ends when it stops git at the cap, even if a process git started still holds its output', async () => {
    const { d, git } = repo()
    git('commit', '-q', '--allow-empty', '-m', 'init')
    const restore = fakeStatus(`sleep 20 & printf '# branch.head main\\0'; i=0; while :; do printf '? new/%s\\0' $i; i=$((i+1)); done`)
    try {
      expect(await gitSummary(d, { trusted: true }, { cap: 10 })).toEqual({ isRepo: true, branch: 'main', changedFiles: 10, more: true })
    } finally {
      restore()
    }
  }, 10_000 * SLOW)

  it.skipIf(!posix)('reads a path whose character is cut between two chunks of git\'s output as one path', async () => {
    const { d, git } = repo()
    git('commit', '-q', '--allow-empty', '-m', 'init')
    // 가 is EA B0 80: the first write ends inside it. The same path then arrives whole
    const restore = fakeStatus(`printf '# branch.head main\\0? \\352\\260'; sleep 0.3; printf '\\200.ts\\0? \\352\\260\\200.ts\\0'; exit 0`)
    try {
      expect(await gitSummary(d, { trusted: true })).toEqual({ isRepo: true, branch: 'main', changedFiles: 1 })
    } finally {
      restore()
    }
  })

  it.skipIf(!posix)('does not call a worktree the system denied clean', async () => {
    const { d, git } = repo()
    git('commit', '-q', '--allow-empty', '-m', 'init')
    const restore = fakeStatus(`echo 'fatal: cannot open .git/index: Operation not permitted' >&2; exit 128`)
    try {
      expect((await gitSummary(d, { trusted: true })).denied).toBe(true)
      expect((await gitWorktreeDirty(d, { trusted: true })).dirty).toBe(true)
    } finally {
      restore()
    }
  })

  it('is still "not a repository" for a folder that is not one', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-not-git-'))
    dirs.push(d)
    expect(await gitSummary(d)).toMatchObject({ isRepo: false, changedFiles: 0 })
  })

  it('counts a file staged for removal and still on disk once, as the panel does', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'a.ts'), 'a\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    // `1 D.` for the index and `? a.ts` for the file still there: one file
    git('rm', '-q', '--cached', 'a.ts')
    expect(changedFileCount(await gitStatusFiles(d))).toBe(1)
    expect((await gitSummary(d)).changedFiles).toBe(1)
  })
})

describe('the changed-file count (#850 item 10)', () => {
  it('is the panel list counted by path: a partly staged file once, each file of a new folder', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'a.ts'), 'one\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    // Staged, then changed again: under Staged and under Changes
    writeFileSync(join(d, 'a.ts'), 'two\n')
    git('add', 'a.ts')
    writeFileSync(join(d, 'a.ts'), 'three\n')
    // A new folder: git's default lists the folder, the panel lists its files
    mkdirSync(join(d, 'new'))
    writeFileSync(join(d, 'new', 'x.ts'), 'x\n')
    writeFileSync(join(d, 'new', 'y.ts'), 'y\n')

    const files = await gitStatusFiles(d)
    expect(files).toHaveLength(4)
    expect(changedFileCount(files)).toBe(3)
    expect((await gitSummary(d)).changedFiles).toBe(3)
  })
})

describe('untrusted repository status', () => {
  // core.fsmonitor is a command from the repository's local config. Merely registering an
  // untrusted folder must not run it before the person has approved that repository.
  it('disables fsmonitor until the project is trusted', async () => {
    const { d, git } = repo()
    const marker = join(d, 'fsmonitor-ran')
    const hook = join(d, 'fsmonitor.sh')
    // Forward slashes: Git for Windows runs the hook through its sh, which reads a backslash as an escape
    const posixPath = (p: string) => p.replaceAll('\\', '/')
    writeFileSync(hook, `#!/bin/sh\nprintf ran >> "${posixPath(marker)}"\nprintf '2\\n'\n`)
    chmodSync(hook, 0o755)
    git('config', 'core.fsmonitor', posixPath(hook))

    const untrusted = { trusted: false }
    expect((await gitSummary(d, untrusted)).isRepo).toBe(true)
    expect(await gitStatusFiles(d, untrusted)).toEqual(expect.any(Array))
    expect(existsSync(marker)).toBe(false)

    expect((await gitSummary(d, { trusted: true })).isRepo).toBe(true)
    expect(existsSync(marker)).toBe(true)
  })
})

describe('git path containment', () => {
  it('rejects no-index diff paths outside a project subdirectory', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'tracked.txt'), 'base\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const sub = join(d, 'pkg')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(d, 'outside.txt'), 'outside\n')

    await expect(gitDiff(sub, '../outside.txt')).rejects.toThrow(/outside the project/i)
  })

  it('names the project root as the root, not as outside the project (#134)', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'tracked.txt'), 'base\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    for (const root of ['.', d, 'sub/..']) {
      await expect(gitDiff(d, root)).rejects.toThrow('Path is the project root, not a file in it')
    }
  })

  it('treats option-looking filenames as paths when diffing and staging', async () => {
    const { d } = repo()
    const name = '--output=owned.patch'
    writeFileSync(join(d, name), 'content\n')

    const argv = recordGitArgv()
    try {
      const diff = await gitDiff(d, name)
      expect(diff.diff).toContain('content')
      await expect(gitStage(d, [name])).resolves.toBeUndefined()
      expect(await gitStatusFiles(d)).toEqual([{ path: name, staged: true, status: 'A' }])
    } finally {
      argv.restore()
    }

    /*
     * Looking at the result alone, only one of the three `--` is actually load-bearing: wherever
     * the `:(literal)` prefix is applied, the argument already starts with `:`, so git has
     * nothing to read as an option, and conversely, wherever `--` is present, the call passes
     * even with no prefix. The two overlap and hide each other's absence, so **removing just one
     * of them still passed** (#121). So this checks the line git actually received, not the
     * result.
     */
    const carrying = argv.calls().filter((args) => args.some((a) => a.includes('owned.patch')))
    expect(carrying.length).toBeGreaterThan(0)
    for (const args of carrying) {
      expect(args.indexOf('--')).toBeGreaterThanOrEqual(0)
      expect(args.indexOf('--')).toBeLessThan(args.findIndex((a) => a.includes('owned.patch')))
    }
  })

  it('rejects symlinked no-index diff paths whose target leaves the project', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'tracked.txt'), 'base\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const outside = mkdtempSync(join(tmpdir(), 'cc-git-outside-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    symlinkSync(outside, join(d, 'linked-out'), 'dir')

    await expect(gitDiff(d, 'linked-out/secret.txt')).rejects.toThrow(/outside the project/i)
    await expect(gitStage(d, ['linked-out/secret.txt'])).rejects.toThrow(/outside the project/i)
  })


  it('rejects git pathspec magic instead of letting it widen selection', async () => {
    const { d } = repo()
    writeFileSync(join(d, 'a.txt'), 'a\n')
    writeFileSync(join(d, 'b.txt'), 'b\n')

    await expect(gitDiff(d, ':(glob)*.txt')).rejects.toThrow(/invalid git path/i)
    await expect(gitStage(d, [':(glob)*.txt'])).rejects.toThrow(/invalid git path/i)
  })

  it('treats wildcard-looking paths literally instead of as git pathspec globs', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'a.txt'), 'a\n')
    writeFileSync(join(d, 'b.txt'), 'b\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(d, 'a.txt'), 'changed\n')
    writeFileSync(join(d, 'b.txt'), 'changed\n')

    const diff = await gitDiff(d, '*.txt')
    expect(diff.diff).toBe('')
    await expect(gitStage(d, ['*.txt'])).rejects.toThrow(/pathspec/i)
    expect(await gitStatusFiles(d)).toEqual([
      { path: 'a.txt', staged: false, status: 'M' },
      { path: 'b.txt', staged: false, status: 'M' },
    ])
  })

  it('rejects stage paths outside the project', async () => {
    const { d } = repo()

    await expect(gitStage(d, ['../outside.txt'])).rejects.toThrow(/outside the project/i)
  })
})

/**
 * The git path leaked through the same split (#119).
 *
 * `assertLexicalGitPath` passed git a string with `..` folded away, while
 * `assertCanonicalGitPath` checked the unfolded string. When a symlink's target sat deeper than
 * the link itself, the two disagreed: the check looked inside the project and passed, while git
 * read the outside file and returned its content as the diff body.
 */
describe('a .. past a symlink cannot reveal an outside file\'s content (#119)', () => {
  it('the diff is rejected', async () => {
    const { d } = repo()
    const outside = mkdtempSync(join(tmpdir(), 'cc-git-outside-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE SECRET')
    mkdirSync(join(d, 'sub', 'deep'), { recursive: true })
    mkdirSync(join(d, 'sub', 'evil'), { recursive: true })
    symlinkSync(join(d, 'sub', 'deep'), join(d, 'link'))
    symlinkSync(outside, join(d, 'evil'))

    await expect(gitDiff(d, 'link/../evil/secret.txt')).rejects.toThrow(/outside the project/i)
  })
})

/**
 * The branch list and checkout (#175) — checked against a real repository with an `origin`. The
 * short name (`refname:short`) does not add `remotes/` to a remote branch, so `origin/main` and
 * `feature/login` could not be told apart by their name alone.
 */
describe('branches with a remote (#175)', () => {
  const withOrigin = () => {
    const { d: upstream, git: up } = repo()
    up('checkout', '-q', '-b', 'main')
    writeFileSync(join(upstream, 'f.txt'), 'original\n')
    up('add', '.')
    up('commit', '-q', '-m', 'init')
    up('branch', 'release')
    const d = mkdtempSync(join(tmpdir(), 'cc-git-clone-'))
    dirs.push(d)
    execFileSync('git', ['clone', '-q', upstream, d])
    const git = (...args: string[]) => execFileSync('git', args, { cwd: d }).toString()
    git('config', 'user.email', 'test@test')
    git('config', 'user.name', 'test')
    git('branch', 'feature/login')
    return { d, git }
  }

  it('sorts local and remote by the full ref, and drops the remote HEAD alias', async () => {
    const { d } = withOrigin()
    const list = await gitBranches(d)
    expect(list.map((b) => [b.name, b.remote])).toEqual([
      ['feature/login', false],
      ['main', false],
      ['origin/main', true],
      ['origin/release', true],
    ])
    expect(list.find((b) => b.name === 'main')).toMatchObject({ current: true, upstream: 'origin/main' })
  })

  it('picking a remote branch makes a tracking branch instead of detaching HEAD', async () => {
    const { d, git } = withOrigin()
    await expect(gitCheckout(d, 'origin/release')).resolves.toEqual({ ok: true, conflicts: [] })
    expect(git('symbolic-ref', '--short', 'HEAD').trim()).toBe('release')
    expect(git('rev-parse', '--abbrev-ref', 'release@{upstream}').trim()).toBe('origin/release')
  })

  it('a branch named like an option is switched to, not run as one', async () => {
    const { d, git } = withOrigin()
    git('update-ref', 'refs/heads/-f', 'HEAD')
    writeFileSync(join(d, 'f.txt'), 'unsaved agent work\n')
    expect((await gitBranches(d)).map((b) => b.name)).toContain('-f')

    await expect(gitCheckout(d, '-f')).resolves.toEqual({ ok: true, conflicts: [] })
    expect(readFileSync(join(d, 'f.txt'), 'utf8')).toBe('unsaved agent work\n')
    expect(git('symbolic-ref', '--short', 'HEAD').trim()).toBe('-f')
  })
})

/**
 * A Korean name comes through the diff header as written (#176). With `core.quotePath` at its
 * default, git wraps it as `diff --git "a/\355\225\234…" "b/…"`, so the label on screen became
 * that raw escaped header, and a click meant to reach the file lost the path.
 */
describe('Korean file names in git output (#176)', () => {
  it('the diff header carries the name as written', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, '한글파일.md'), 'v1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(d, '한글파일.md'), 'v2\n')

    const { diff } = await gitDiff(d, '한글파일.md')
    expect(diff.split('\n')[0]).toBe('diff --git a/한글파일.md b/한글파일.md')
  })
})

describe('commit detail and commit errors (#160)', () => {
  it('a clean merge shows what it brought in from the merged branch', async () => {
    const { d, git } = repo()
    git('checkout', '-q', '-b', 'main')
    writeFileSync(join(d, 'a.txt'), 'a\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    git('checkout', '-q', '-b', 'side')
    writeFileSync(join(d, 'b.txt'), 'b\n')
    git('add', '.')
    git('commit', '-q', '-m', 'side')
    git('checkout', '-q', 'main')
    writeFileSync(join(d, 'c.txt'), 'c\n')
    git('add', '.')
    git('commit', '-q', '-m', 'main moves on')
    git('merge', '-q', '--no-edit', 'side')
    const merge = git('rev-parse', 'HEAD').toString().trim()

    const detail = await gitCommitDetail(d, merge)
    expect(detail.files).toEqual(['b.txt'])
    expect(detail.diff).toContain('+++ b/b.txt')
  })

  it('a commit with nothing to commit says why', async () => {
    const { d, git } = repo()
    writeFileSync(join(d, 'a.txt'), 'a\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')

    const r = await gitCommit(d, 'my message')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/nothing to commit/)
  })
})

/*
 * #134: the cap is in characters (why the name is `maxChars`). Both places (`gitDiff`, `gitCommitDetail`) share the one named value.
 */
describe('the diff cap counts characters and is one named value (#134)', () => {
  it('maxChars cuts at that many characters even when the bytes are several times more', async () => {
    const { d } = repo()
    writeFileSync(join(d, '한글.txt'), '가나다라마바사아자차카타파하\n'.repeat(200))
    const { diff, truncated } = await gitDiff(d, '한글.txt', { maxChars: 1_000 })
    expect(truncated).toBe(true)
    expect(diff.length).toBe(1_000)
    expect(Buffer.byteLength(diff, 'utf8')).toBeGreaterThan(2_000) // if this counted bytes, it would have cut off here
  })

  it('both the working diff and the commit diff stop at GIT_DIFF_MAX_CHARS', async () => {
    const { d, git } = repo()
    const big = Array.from({ length: 40_000 }, (_, i) => `line-${String(i).padStart(6, '0')}`).join('\n') + '\n'
    writeFileSync(join(d, 'big.txt'), big)
    const working = await gitDiff(d, 'big.txt')
    expect(working).toMatchObject({ truncated: true })
    expect(working.diff.length).toBe(GIT_DIFF_MAX_CHARS)
    git('add', '.')
    git('commit', '-q', '-m', 'big')
    const sha = git('rev-parse', 'HEAD').toString().trim()
    const detail = await gitCommitDetail(d, sha)
    expect(detail.truncated).toBe(true)
    expect(detail.diff.length).toBe(GIT_DIFF_MAX_CHARS)
  })
})

/*
 * #849: the sizes beside the copy candidates. Given a bare name, Windows looks in the child's working folder before
 * PATH, and du ran with the project as that folder, so a `du.exe` committed to a repository ran on the first look at
 * this list (and with none planted, Windows has no du on PATH, so every size was empty). The planted one here is a
 * copy of node, which prints nothing for `-sk`: had it run, there would be no sizes.
 */
describe('the sizes of ignored entries', () => {
  it('measures them without running a du planted in the project', async () => {
    const { d } = repo()
    writeFileSync(join(d, '.gitignore'), 'build/\n')
    mkdirSync(join(d, 'build', 'deep'), { recursive: true })
    writeFileSync(join(d, 'build', 'a.bin'), Buffer.alloc(1000))
    writeFileSync(join(d, 'build', 'deep', 'b.bin'), Buffer.alloc(500))
    for (const name of ['du.exe', 'du']) {
      try {
        linkSync(process.execPath, join(d, name))
      } catch {
        copyFileSync(process.execPath, join(d, name))
      }
    }
    // Set, it stops Windows looking in the working folder first; a person's environment rarely has it
    const noCwd = process.env.NoDefaultCurrentDirectoryInExePath
    delete process.env.NoDefaultCurrentDirectoryInExePath
    let entries
    try {
      entries = await gitIgnoredEntries(d)
    } finally {
      if (noCwd !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = noCwd
    }
    // du counts blocks on disk, the file system walk bytes: either way at least what was written
    expect(entries.find((e) => e.path === 'build/')?.bytes).toBeGreaterThanOrEqual(1500)
  })
})

/*
 * #849 review: one folder of a million files queued a million lstat calls at once. The walk measures in batches,
 * checks its deadline between them, and gives up past a number of entries, leaving that entry without a size.
 */
describe('the file system walk that sizes an ignored entry', () => {
  it('adds up the bytes, and has no size past its entry cap or its deadline', async () => {
    const { d } = repo()
    mkdirSync(join(d, 'many'))
    for (let i = 0; i < 600; i++) writeFileSync(join(d, 'many', `${i}.bin`), Buffer.alloc(10))
    expect(await treeBytes(join(d, 'many'), Date.now() + 60_000)).toBe(6000)
    expect(await treeBytes(join(d, 'many'), Date.now() + 60_000, 500)).toBeNull()
    expect(await treeBytes(join(d, 'many'), Date.now() - 1)).toBeNull()
  })
})
