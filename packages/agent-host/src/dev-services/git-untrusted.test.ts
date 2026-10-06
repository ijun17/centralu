import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  gitCheckout,
  gitCommitDetail,
  gitDiff,
  gitIgnoredEntries,
  gitLog,
  gitStatusFiles,
  gitSummary,
  gitWorktreeAdd,
  gitWorktreeDirty,
  type GitTrust,
} from './git.js'
import { gitArgv } from './git-exec.js'
import { listDir } from './fs.js'
import { invalidateFileIndex, searchFiles } from './file-search.js'
import { plantedRepo, type PlantedRepo } from './planted-repo.test-helpers.js'

/**
 * Before a project is trusted, no git read runs a program the repository chose (#407).
 *
 * Every read the host makes on a project is run against a copied repository with hooks, filters,
 * textconv, an external diff, fsmonitor and gpg planted in its `.git`, and must leave no marker.
 * The same read for a trusted project is the control: it shows the fixture really does reach those
 * programs through that read, so "nothing ran" is a finding and not a fixture that never fires.
 */

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 5 })
  invalidateFileIndex()
})

function repo(opts: { processFilter?: boolean } = {}): PlantedRepo {
  const r = plantedRepo(opts)
  roots.push(r.root)
  return r
}

const UNTRUSTED: GitTrust = {}
const TRUSTED: GitTrust = { trusted: true }

type Read = {
  name: string
  read: (r: PlantedRepo, trust: GitTrust) => Promise<unknown>
  /** What the read still has to answer before trust: the locks must not cost it its result */
  answers: (result: unknown) => void
  /** Planted programs this read reaches for a trusted project */
  trustedRuns: string[]
}

const READS: Read[] = [
  {
    name: 'gitSummary (projects.list, projects.gitStatus)',
    read: (r, t) => gitSummary(r.dir, t),
    answers: (s) => expect(s).toMatchObject({ isRepo: true, branch: 'main', changedFiles: 2 }),
    trustedRuns: ['clean', 'fsmonitor', 'hook-post-index-change'],
  },
  {
    name: 'gitStatusFiles (git.status)',
    read: (r, t) => gitStatusFiles(r.dir, t),
    answers: (files) =>
      expect(files).toEqual([
        { path: 'a.txt', staged: false, status: 'M' },
        { path: 'new.txt', staged: false, status: '?' },
      ]),
    trustedRuns: ['clean', 'fsmonitor', 'hook-post-index-change'],
  },
  {
    name: 'the file tree (check-ignore)',
    read: (r, t) => listDir(r.dir, '', t),
    answers: (entries) => expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ignored.log', ignored: true })])),
    trustedRuns: ['fsmonitor'],
  },
  {
    name: 'file search (ls-files --others)',
    read: (r, t) => searchFiles(r.dir, 'new', 20, t),
    answers: (hits) => expect(hits).toEqual(expect.arrayContaining([{ path: 'new.txt', name: 'new.txt' }])),
    trustedRuns: ['fsmonitor'],
  },
  {
    name: 'ignored entries (ls-files --ignored)',
    read: (r, t) => gitIgnoredEntries(r.dir, 50, t),
    answers: (entries) => expect(entries).toEqual([expect.objectContaining({ path: 'ignored.log' })]),
    trustedRuns: ['fsmonitor'],
  },
  {
    name: 'git.diff of a tracked file',
    read: (r, t) => gitDiff(r.dir, 'a.txt', t),
    answers: (d) => expect((d as { diff: string }).diff).toContain('+changed in the copy'),
    trustedRuns: ['clean', 'fsmonitor', 'smudge', 'textconv'],
  },
  {
    name: 'git.diff of an untracked file (--no-index)',
    read: (r, t) => gitDiff(r.dir, 'new.txt', t),
    answers: (d) => expect((d as { diff: string }).diff).toContain('+untracked'),
    trustedRuns: ['textconv'],
  },
  {
    name: 'git.commitDetail (show)',
    read: (r, t) => gitCommitDetail(r.dir, r.signed, t),
    answers: (d) => expect(d).toMatchObject({ files: ['a.txt'], diff: expect.stringContaining('+signed') }),
    trustedRuns: ['gpg', 'smudge', 'textconv'],
  },
  {
    name: 'git.log',
    read: (r) => gitLog(r.dir),
    answers: (commits) => expect((commits as { subject: string }[]).map((c) => c.subject)).toEqual(['batch', 'signed', 'init']),
    trustedRuns: [],
  },
  {
    name: 'the checkout dry run',
    read: (r, t) => gitCheckout(r.dir, 'main', { dryRun: true, ...t }),
    answers: (c) => expect(c).toEqual({ ok: false, conflicts: ['a.txt'] }),
    trustedRuns: ['fsmonitor'],
  },
  {
    name: 'the worktree dirty check',
    read: (r, t) => gitWorktreeDirty(r.dir, t),
    answers: (w) => expect(w).toEqual({ dirty: true, changedFiles: 2 }),
    trustedRuns: ['fsmonitor'],
  },
]

describe('git reads before trust run none of the repository’s programs (#407)', () => {
  it.each(READS)('$name', async ({ read, answers }) => {
    const r = repo()
    answers(await read(r, UNTRUSTED))
    expect(r.ran()).toEqual([])
  })

  /*
   * The control. A trusted project keeps plain git's behaviour (fsmonitor stays on for the checkout
   * dry run and the worktree dirty check, which can take long on a large repository without it).
   * git.log is the exception: it runs locked for every project, and the signature check it skips
   * would only have printed into output this parser does not read.
   */
  it.each(READS.filter((r) => r.trustedRuns.length > 0))('$name, trusted, still runs them', async ({ read, trustedRuns }) => {
    const r = repo()
    await read(r, TRUSTED)
    expect(r.ran()).toEqual(expect.arrayContaining(trustedRuns))
  })

  it('a long-running filter process does not start before trust, and does after', async () => {
    const r = repo({ processFilter: true })
    await gitStatusFiles(r.dir, UNTRUSTED)
    expect(r.ran()).toEqual([])
    await gitStatusFiles(r.dir, TRUSTED).catch(() => [])
    expect(r.ran()).toContain('process')
  })

  it('git.log reaches gpg.program in this fixture when nothing locks it', () => {
    const r = repo()
    execFileSync('git', ['log', '-n3', '--pretty=format:%H'], { cwd: r.dir })
    expect(r.ran()).toEqual(['gpg'])
  })
})

describe('worktrees before trust (#407)', () => {
  it('refuses to create one, running nothing and leaving no branch behind', async () => {
    const r = repo()
    const path = join(r.root, 'wt')
    await expect(gitWorktreeAdd(r.dir, path, 'centralu/untrusted', undefined, UNTRUSTED)).rejects.toThrow(/trusted project/)
    expect(r.ran()).toEqual([])
    expect(existsSync(path)).toBe(false)
    expect(execFileSync('git', ['branch', '--list', 'centralu/untrusted'], { cwd: r.dir, encoding: 'utf8' })).toBe('')
  })

  it('a trusted project checks out as plain git does, hooks and filters included', async () => {
    const r = repo()
    const path = join(r.root, 'wt')
    await gitWorktreeAdd(r.dir, path, 'centralu/trusted', undefined, TRUSTED)
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
    expect(r.ran()).toEqual(expect.arrayContaining(['hook-post-checkout', 'hook-reference-transaction', 'smudge']))
  })
})

describe('the worktree dirty check before trust (#407)', () => {
  /*
   * Before trust, status does not descend into a submodule (its own config could name a filter
   * that was not turned off), so the check that guards a forced removal cannot see work inside one.
   * A submodule then counts as a change: removal asks first rather than guessing.
   */
  it('counts a submodule as a change, since it cannot look inside', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-gitlink-'))
    roots.push(d)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: d, encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(d, 'a.txt'), 'a\n')
    git('add', 'a.txt')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
    const sha = git('rev-parse', 'HEAD').trim()
    git('update-index', '--add', '--cacheinfo', `160000,${sha},nested`)
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'gitlink')

    expect((await gitSummary(d, UNTRUSTED)).changedFiles).toBe(0)
    expect(await gitWorktreeDirty(d, UNTRUSTED)).toEqual({ dirty: true, changedFiles: 1 })
  })
})

describe('filter drivers git cannot be told to turn off (#407)', () => {
  it('refuses the read instead of letting the driver through', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-filter-name-'))
    roots.push(d)
    execFileSync('git', ['init', '-q'], { cwd: d })
    // `-c filter.a=b.clean=` would be split at the first `=`, so this driver cannot be named there
    execFileSync('git', ['config', 'filter.a=b.clean', 'cat'], { cwd: d })
    await expect(gitArgv(d, ['status'])).rejects.toThrow(/cannot be turned off/)
  })
})
