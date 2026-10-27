import { afterEach, describe, expect, it } from 'vitest'
import { reachesAgentFolder, SCAN_LIMITS, within, type AgyHome } from './agent-files.js'
import { fakeSignIn, folder, folderLink, pathFrom, pathIn, posixPaths, sep, tempData, thisHost, tokenPath, write } from './agent-files.test-helpers.js'

/**
 * The guard on the agent's own folder (`reachesAgentFolder`, plan §4.2) against the requests a recheck of #1680 let through:
 * it fails closed, so each case here is one the guard cannot prove stays outside. The folder is a real temporary one, so
 * links, junctions, 8.3 names and case are the file system's own.
 */

const WINDOWS = process.platform === 'win32'
const SID = 'ses-guard'

const data: { done(): void }[] = []
afterEach(() => {
  for (const d of data.splice(0)) d.done()
})

function world(): { dir: string; home: AgyHome; project: string; token: string } {
  const t = tempData()
  data.push(t)
  fakeSignIn(t.home)
  const p = tempData()
  data.push(p)
  const project = pathIn(p.dir, 'project')
  folder(project)
  write(pathIn(project, 'a.txt'), 'a')
  return { dir: t.dir, home: t.home, project, token: tokenPath(t.home) }
}

const edit = (target: unknown) => ({ kind: 'edit', rawInput: { TargetFile: target } })
const reaches = (home: AgyHome, call: unknown, cwd: string) => reachesAgentFolder(home, call, SID, cwd)

describe('a request that cannot be read whole is refused', () => {
  it('past 64 paths: padding before the token does not hide it, and past the bound the request is refused unread', async () => {
    const w = world()
    const padded = [...Array.from({ length: 70 }, (_, i) => pathIn(w.project, `f${i}.txt`)), w.token]
    expect(await reaches(w.home, { kind: 'edit', rawInput: { Chunks: padded } }, w.project)).toBe(true)
    const many = Array.from({ length: SCAN_LIMITS.strings + 1 }, (_, i) => pathIn(w.project, `f${i}.txt`))
    expect(await reaches(w.home, { kind: 'edit', rawInput: { Chunks: many } }, w.project)).toBe(true)
    // Below the bound, the same shape is judged and let through
    expect(await reaches(w.home, { kind: 'edit', rawInput: { Chunks: many.slice(0, 100) } }, w.project)).toBe(false)
  })

  it('nested deeper than 8 levels: the token is still found, and past the bound the request is refused unread', async () => {
    const w = world()
    const nest = (v: unknown, n: number): unknown => (n === 0 ? v : { a: nest(v, n - 1) })
    expect(await reaches(w.home, { kind: 'edit', rawInput: nest(w.token, 10) }, w.project)).toBe(true)
    expect(await reaches(w.home, { kind: 'edit', rawInput: nest(pathIn(w.project, 'a.txt'), SCAN_LIMITS.depth + 1) }, w.project)).toBe(true)
    expect(await reaches(w.home, { kind: 'edit', rawInput: nest(pathIn(w.project, 'a.txt'), 10) }, w.project)).toBe(false)
  })

  it('reads object keys and a string that holds JSON (a replayed rawInput)', async () => {
    const w = world()
    expect(await reaches(w.home, { kind: 'edit', rawInput: { files: { [w.token]: 'x' } } }, w.project)).toBe(true)
    expect(await reaches(w.home, { kind: 'edit', rawInput: JSON.stringify({ TargetFile: w.token }) }, w.project)).toBe(true)
  })
})

describe('a folder above the agent folder, or a glob from one, reaches inside', () => {
  it('the data folder, its tools folder and the folder itself, as a listing or a search would name them', async () => {
    const w = world()
    for (const at of [w.dir, pathIn(w.dir, 'tools'), w.home.root, `${pathIn(w.dir, 'tools')}${sep}`, pathIn(w.dir, '..')]) {
      expect(await reaches(w.home, { kind: 'search', rawInput: { SearchPath: at, Query: 'token' } }, w.project), at).toBe(true)
    }
    // Relative to a session folder that is the data folder
    expect(await reaches(w.home, { kind: 'search', rawInput: { SearchPath: '.' } }, w.dir)).toBe(true)
  })

  it('a glob whose fixed prefix is one of them, and a glob that climbs back after a wildcard', async () => {
    const w = world()
    expect(await reaches(w.home, { kind: 'search', rawInput: { Glob: pathIn(w.dir, 'tools', '**', 'acp_token.json') } }, w.project)).toBe(true)
    expect(await reaches(w.home, { kind: 'search', rawInput: { Glob: pathIn(w.dir, '*') } }, w.project)).toBe(true)
    expect(await reaches(w.home, { kind: 'search', rawInput: { Glob: [w.project, '**', '..', '..', 'x'].join(sep) } }, w.project)).toBe(true)
    // A glob in the project stays there
    expect(await reaches(w.home, { kind: 'search', rawInput: { Glob: pathIn(w.project, '**', '*.ts') } }, w.project)).toBe(false)
  })

  it("does not count a shell call's folder as reaching (its command is not read anyway), but does count one inside", async () => {
    const w = world()
    expect(await reaches(w.home, { kind: 'execute', rawInput: { CommandLine: 'ls', Cwd: w.dir } }, w.project)).toBe(false)
    expect(await reaches(w.home, { kind: 'execute', rawInput: { CommandLine: 'ls', Cwd: w.home.geminiHome } }, w.project)).toBe(true)
  })

  it("lets a file in this conversation's plan through, but not the plan folder or a glob in it", async () => {
    const w = world()
    const plans = pathIn(w.home.geminiHome, 'antigravity-acp', 'brain', SID)
    folder(plans)
    expect(await reaches(w.home, edit(pathIn(plans, 'plan.md')), w.project)).toBe(false)
    expect(await reaches(w.home, { kind: 'search', rawInput: { SearchPath: plans } }, w.project)).toBe(true)
    expect(await reaches(w.home, { kind: 'search', rawInput: { Glob: pathIn(plans, '*.md') } }, w.project)).toBe(true)
  })
})

describe('the ways one file is spelled', () => {
  it('in quotes, and through an environment variable the agent has', async () => {
    const w = world()
    expect(await reaches(w.home, edit(`"${w.token}"`), w.project)).toBe(true)
    expect(await reaches(w.home, edit(`'${w.token}'`), w.project)).toBe(true)
    const rest = pathFrom(w.home.geminiHome, w.token)
    expect(await reaches(w.home, edit(`$GEMINI_HOME/${rest}`), w.project)).toBe(true)
    expect(await reaches(w.home, edit(`\${GEMINI_HOME}/${rest}`), w.project)).toBe(true)
    if (WINDOWS) expect(await reaches(w.home, edit(`%gemini_home%\\${rest}`), w.project)).toBe(true)
  })

  it('through a link or junction in the project to the folder (the real path is judged, on every OS)', async () => {
    const w = world()
    folderLink(pathIn(w.home.geminiHome, 'antigravity-acp'), pathIn(w.project, 'notes'))
    expect(await reaches(w.home, edit(pathIn(w.project, 'notes', 'acp_token.json')), w.project)).toBe(true)
    expect(await reaches(w.home, edit(pathIn(w.project, 'notes', 'new.txt')), w.project)).toBe(true)
    // A link to the data folder is a parent of the agent folder
    folderLink(w.dir, pathIn(w.project, 'data'))
    expect(await reaches(w.home, { kind: 'search', rawInput: { SearchPath: pathIn(w.project, 'data') } }, w.project)).toBe(true)
  })

  it.runIf(!WINDOWS)('takes `..` after a link where it leads, as the kernel does, not by the text', async () => {
    const w = world()
    folderLink(pathIn(w.home.geminiHome, 'antigravity-acp', 'brain'), pathIn(w.project, 'b'))
    // As text this is <project>/acp_token.json; the kernel reads <agent folder>/antigravity-acp/acp_token.json
    expect(await reaches(w.home, edit(`${w.project}/b/../acp_token.json`), w.project)).toBe(true)
  })

  it('folds case by itself, not only through the file system (POSIX rules, so every OS runs it)', () => {
    expect(within('/data/tools/antigravity', '/DATA/Tools/Antigravity/gemini-home/x', posixPaths)).toBe(true)
    expect(within('/data/tools/antigravity', '/data/tools/antigravity-other', posixPaths)).toBe(false)
  })

  it.runIf(WINDOWS)('drive-relative (`C:foo`), and from the root of the drive (`\\foo`)', async () => {
    const w = world()
    const drive = w.dir.slice(0, 2)
    expect(await reaches(w.home, edit(`${drive}${pathFrom(w.dir, w.token)}`), w.dir)).toBe(true)
    expect(await reaches(w.home, edit(`${drive}${w.token.slice(3)}`), w.project)).toBe(true)
    expect(await reaches(w.home, edit(w.token.slice(2)), w.project)).toBe(true)
  })

  it.runIf(WINDOWS)("a network path to this machine's own drive: the admin share, by any name of this machine", async () => {
    const w = world()
    const drive = w.token[0]!
    const rest = w.token.slice(3)
    for (const host of ['localhost', '127.0.0.1', thisHost(), '?\\UNC\\localhost', '.\\UNC\\localhost']) {
      const unc = `\\\\${host}\\${drive}$\\${rest}`
      expect(await reaches(w.home, edit(unc), w.project), unc).toBe(true)
      expect(await reaches(w.home, edit(unc.replace(/\\/g, '/')), w.project), unc).toBe(true)
    }
    // A parent over the share too
    expect(await reaches(w.home, { kind: 'search', rawInput: { SearchPath: `\\\\localhost\\${drive}$\\` } }, w.project)).toBe(true)
  })

  it('lets ordinary work through: project files, prose, a new file, a search of the project', async () => {
    const w = world()
    const asks = [
      edit(pathIn(w.project, 'a.txt')),
      edit(pathIn(w.project, 'src', 'new.ts')),
      { kind: 'edit', title: 'Run write_to_file?', rawInput: { TargetFile: pathIn(w.project, 'b.md'), CodeContent: 'one line: a/b?', Description: 'Update the notes.' } },
      { kind: 'search', rawInput: { SearchPath: w.project, Glob: '**/*.ts' } },
      { kind: 'search', rawInput: { SearchPath: '.', Query: 'x' } },
    ]
    for (const ask of asks) expect(await reaches(w.home, ask, w.project), JSON.stringify(ask)).toBe(false)
  })
})
