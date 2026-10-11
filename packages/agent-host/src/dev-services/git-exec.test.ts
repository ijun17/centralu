import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGit } from './git-exec.js'

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
  it('fails only the call: EPIPE on its stdin never escapes', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'cc-git-epipe-'))
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => void uncaught.push(e)
    process.on('uncaughtException', onUncaught)
    try {
      await expect(runGit(notARepo, ['commit', '-F', '-'], { input: 'x'.repeat(8 * 1024 * 1024) })).rejects.toThrow()
      await new Promise((r) => setTimeout(r, 100))
      expect(uncaught.map((e) => (e as NodeJS.ErrnoException).code)).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})
