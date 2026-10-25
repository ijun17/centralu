import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { outOfReach, pinned, readScope } from './asked-reach.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

const reachOf = (folder: string) => ({ folders: [folder], project: 'p1', thread: 't1' })
const check = (name: string, args: Record<string, unknown>, folder: string) => {
  const scope = readScope(name, args)
  return scope && outOfReach(name, scope, reachOf(folder), () => undefined)
}

describe('what a call reads is an allowlist (§9.7)', () => {
  it('a tool not known counts as reading everything; the CLI’s sight of a Centralu tool is nothing, since its own call is noted', () => {
    expect(readScope('a_tool_added_next_year', {})).toEqual({ everywhere: true })
    expect(readScope('Task', {})).toEqual({ everywhere: true })
    expect(readScope('mcp__centralu__list_sessions', {})).toBeNull()
    expect(readScope('Write', { file_path: '/x' })).toBeNull()
    expect(readScope('Read', { file_path: '/x' })).toEqual({ paths: ['/x'] })
    expect(readScope('ask_project', { project: 'zed' })).toEqual({ project: 'zed' })
  })

  it('a path is pinned to where it was when it was read', () => {
    const scope = pinned({ paths: [process.cwd()] })
    expect('real' in scope && scope.real).toHaveLength(1)
    expect(pinned({ everywhere: true })).toEqual({ everywhere: true })
  })
})

describe('what a read reaches, as the file system has it (§9.7)', () => {
  it('a link inside the asker’s folder to a place outside it is that place, not the folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-reach-link-'))
    dirs.push(root)
    const project = join(root, 'project')
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(project)
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'secret.txt'), 'hunter2')
    writeFileSync(join(project, 'mine.txt'), 'mine')
    try {
      // A junction on Windows (no privilege needed), a symbolic link elsewhere
      symlinkSync(elsewhere, join(project, 'link'), 'junction')
    } catch (err) {
      // Where the OS refuses to make a link there is nothing to resolve: say so rather than pass
      console.warn(`asked-reach.test: no link could be made here (${err instanceof Error ? err.message : String(err)}); the case is not exercised`)
      return
    }
    expect(check('Read', { file_path: join(project, 'mine.txt') }, project)).toBeNull()
    // The path says "inside the project"; the file is not
    expect(check('Read', { file_path: join(project, 'link', 'secret.txt') }, project)).toContain('Read of')
    expect(check('Grep', { pattern: 'x', path: join(project, 'link') }, project)).toContain('Grep of')
    expect(check('Glob', { pattern: '*.txt', path: join(project, 'link') }, project)).toContain('Glob of')
    // A file that does not exist yet is judged by the folder it would be in
    expect(check('Read', { file_path: join(project, 'link', 'new.txt') }, project)).toContain('Read of')
    expect(check('Read', { file_path: join(project, 'new.txt') }, project)).toBeNull()
  })

  it('and the asker’s folder may itself be reached by a link', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-reach-link-'))
    dirs.push(root)
    const real = join(root, 'real')
    mkdirSync(real)
    writeFileSync(join(real, 'a.txt'), 'a')
    const alias = join(root, 'alias')
    try {
      symlinkSync(real, alias, 'junction')
    } catch (err) {
      console.warn(`asked-reach.test: no link could be made here (${err instanceof Error ? err.message : String(err)}); the case is not exercised`)
      return
    }
    expect(check('Read', { file_path: join(real, 'a.txt') }, alias)).toBeNull()
    expect(check('Read', { file_path: join(alias, 'a.txt') }, real)).toBeNull()
  })
})
