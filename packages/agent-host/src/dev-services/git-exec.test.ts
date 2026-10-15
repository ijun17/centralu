import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gitArgv, gitFilterListings, runGit } from './git-exec.js'

/**
 * Every git the host starts goes through `runGit` (#407), so a new call is locked before trust by
 * default instead of by remembering to. This reads the sources: a file other than `git-exec.ts`
 * that names git as a program to start fails here, whichever way it starts it.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED = new Set(['dev-services/git-exec.ts'])

/** `programPath('git')`, or git as the program of execFile / spawn / exec / execFileSync */
const STARTS_GIT = /programPath\(\s*['"`]git['"`]\s*\)|\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)\(\s*['"`]git(?:\.exe)?['"`]/

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (/\.(?:ts|mts|js|mjs)$/.test(entry.name) && !/\.test(?:-helpers)?\.ts$/.test(entry.name)) out.push(path)
  }
  return out
}

describe('git is started in one place', () => {
  it('no source outside git-exec.ts starts git itself', () => {
    const offenders = sources(SRC)
      .map((path) => relative(SRC, path).replaceAll('\\', '/'))
      .filter((rel) => !ALLOWED.has(rel) && STARTS_GIT.test(readFileSync(join(SRC, rel), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the check sees the ways a call could be written', () => {
    for (const line of [
      "spawn(programPath('git'), ['status'])",
      "await exec(programPath( 'git' ), args)",
      "execFileSync('git', ['status'])",
      'spawn("git.exe", [])',
    ]) {
      expect(STARTS_GIT.test(line)).toBe(true)
    }
    expect(STARTS_GIT.test("exec(programPath('gh'), ['pr', 'view'])")).toBe(false)
  })
})

/**
 * A git that exits before reading what it was given (lessons HO14): the write lands on a closed
 * pipe, and a stream 'error' nobody listens to is an uncaught exception that ends the host and
 * every session. The input is several times a pipe's buffer, so the write is still going when git
 * has already said `fatal: not a git repository` and gone.
 */
describe('input to a git that does not read it', () => {
  it.each([false, true])('fails only the call: EPIPE on its stdin never escapes (file output: %s)', async (fileOutput) => {
    const notARepo = mkdtempSync(join(tmpdir(), 'cc-git-epipe-'))
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => void uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      await expect(runGit(notARepo, ['commit', '-F', '-'], { input: 'x'.repeat(8 * 1024 * 1024), ...(fileOutput ? { outputFile: join(notARepo, 'output') } : {}) })).rejects.toThrow()
      await new Promise((r) => setTimeout(r, 100))
      expect(uncaught.map((e) => (e as NodeJS.ErrnoException).code)).toEqual([])
      if (fileOutput) expect(readFileSync(join(notARepo, 'output'), 'utf8')).toBe('')
    } finally {
      process.off('uncaughtException', onUncaught)
      rmSync(notARepo, { recursive: true, force: true })
    }
  })
})

describe('git output written directly to a file', () => {
  it('does not impose the stdout buffer limit on repository listings', async () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-git-output-')))
    try {
      await runGit(repo, ['init', '-q'])
      const outputFile = join(repo, 'output')
      // rev-parse has deterministic output larger than this deliberately tiny buffer.
      await expect(runGit(repo, ['rev-parse', '--absolute-git-dir'], { maxBuffer: 1, outputFile })).resolves.toBe('')
      const actual = realpathSync.native(readFileSync(outputFile, 'utf8').trim()).replaceAll('\\', '/')
      const expected = realpathSync.native(join(repo, '.git')).replaceAll('\\', '/')
      expect(actual).toBe(expected)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('one listing of the filter drivers for one operation (#368)', () => {
  it('lists once for the calls that share it, and lists again after a listing that failed', async () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-git-filters-')))
    try {
      await runGit(repo, ['init', '-q'])
      await runGit(repo, ['config', 'filter.planted.clean', 'planted-clean'])
      const config = join(repo, '.git', 'config')
      const good = readFileSync(config, 'utf8')
      const shared = gitFilterListings()
      expect(await gitArgv(repo, ['status'], false, shared)).toContain('filter.planted.clean=')
      // A driver added later is not seen by calls that share the earlier listing; a new operation sees it
      await runGit(repo, ['config', 'filter.later.clean', 'later-clean'])
      expect(await gitArgv(repo, ['ls-files'], false, shared)).not.toContain('filter.later.clean=')
      expect(await gitArgv(repo, ['ls-files'], false, gitFilterListings())).toContain('filter.later.clean=')
      expect(await gitArgv(repo, ['ls-files'])).toContain('filter.later.clean=')
      // A configuration git cannot read fails the listing, and that failure is not kept for the next call
      const failing = gitFilterListings()
      writeFileSync(config, '[broken')
      await expect(gitArgv(repo, ['status'], false, failing)).rejects.toThrow()
      writeFileSync(config, good)
      expect(await gitArgv(repo, ['status'], false, failing)).toContain('filter.planted.clean=')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
