import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

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
