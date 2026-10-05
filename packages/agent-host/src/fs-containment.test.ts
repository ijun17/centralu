import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { Store } from './dev-services/store.js'
import { SessionManager } from './sessions/manager.js'
import { createRpcHandler } from './rpc.js'

/**
 * Never steps through a link inside the project and out — **from the RPC door** (#86).
 *
 * Several tests already check the same rule: fs.test.ts, watch.test.ts, git.test.ts,
 * fs-read-safety.test.ts. All of them call the dev-service functions directly. So one thing is
 * left uncovered — **does the door the webview actually knocks on reach that function.** If the
 * manager gets swapped for a helper that bypasses the guard, or a new fs method gets added, the
 * tests above stay green while a hole opens up. #86 bundles not one function but **five
 * surfaces**, so there has to be one place with proof that all five stay closed when knocked on
 * from outside.
 *
 * The repository is a real `git init`. In a plain temp directory, both `git ls-files` and
 * `check-ignore` return empty-handed, and that would pass green for having nothing to look at,
 * not for nothing leaking.
 *
 * There are three decoy shapes, because the way a link gets presented to the guard differs by
 * shape:
 *   leakfile        the last segment is a file outside
 *   nest/leak/…     a middle segment is a directory outside
 *   link/../evil    a path that climbs back up with `..` **after** following a link (the split #119 closed)
 */

let fixture = ''
let root = ''
let outside = ''
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''

const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })

/** The place all three decoys are run through — blocking only one is useless if the rest are windows */
const ESCAPING_DIRS = ['leak', 'nest/leak', 'link/../evil'] as const
const ESCAPING_FILES = ['leakfile', 'leak/secret.txt', 'nest/leak/secret.txt', 'link/../evil/secret.txt'] as const

beforeEach(async () => {
  // native: on Windows the temp folder can be an 8.3 short name (C:\Users\RUNNER~1), which only the native call expands,
  // and the host answers with the expanded path (#14)
  fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-contain-')))
  root = join(fixture, 'project')
  outside = join(fixture, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n')

  git(['init', '-q'])
  git(['config', 'user.email', 't@t'])
  git(['config', 'user.name', 't'])

  writeFileSync(join(root, 'inside.txt'), 'inside\n')
  mkdirSync(join(root, 'dst'))
  symlinkSync(outside, join(root, 'leak'), 'dir')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leakfile'))
  mkdirSync(join(root, 'nest'))
  symlinkSync(outside, join(root, 'nest', 'leak'), 'dir')
  // The link's target sits deeper than the link itself — the shape where the guard and the syscall used to disagree (#119)
  mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
  mkdirSync(join(root, 'sub', 'evil'))
  symlinkSync(join(root, 'sub', 'deep'), join(root, 'link'), 'dir')
  symlinkSync(outside, join(root, 'evil'), 'dir')
  // Lets the repository track the link — a link planted by a checkout is this item's threat model
  git(['add', '-A'])
  git(['commit', '-qm', 'plant'])

  const adapters = new Map<ToolName, AgentAdapter>()
  const mgr = new SessionManager(new Store(), adapters, () => {})
  rpc = createRpcHandler(mgr, adapters)
  projectId = ((await rpc('projects.add', { path: root })) as { id: string }).id
})

afterEach(async () => {
  // Leaving the watcher running would hold onto the deleted directory and keep the process from ending
  await rpc('fs.watch', { projectId, paths: [] })
  rmSync(fixture, { recursive: true, force: true })
})

describe('surface 1 — read', () => {
  it('rejects every read that passes through a link pointing outside', async () => {
    for (const path of ESCAPING_FILES) {
      await expect(rpc('fs.readFile', { projectId, path }), path).rejects.toThrow(/outside the project/i)
    }
  })

  it('reads a file inside the project as usual', async () => {
    await expect(rpc('fs.readFile', { projectId, path: 'inside.txt' })).resolves.toMatchObject({ text: 'inside\n' })
  })
})

describe('surface 2 — listing', () => {
  it('does not list a directory pointing outside', async () => {
    for (const path of ESCAPING_DIRS) {
      await expect(rpc('fs.listDir', { projectId, path }), path).rejects.toThrow(/outside the project/i)
    }
  })

  /**
   * In the root listing, a link comes back as a **file** (`isDir: false`). This is because
   * readdir's Dirent uses lstat and does not follow the link, which in turn means the tree never
   * tries to expand that entry. What is checked here is that no name from outside slips into the
   * listing.
   */
  it('no name from outside is mixed into the root listing', async () => {
    const entries = (await rpc('fs.listDir', { projectId, path: '' })) as { name: string; isDir: boolean }[]
    expect(entries.map((e) => e.name)).not.toContain('secret.txt')
    expect(entries.find((e) => e.name === 'leak')?.isDir).toBe(false)
  })
})

describe('surface 3 — watch', () => {
  it('does not attach a watcher to a directory pointing outside', async () => {
    const res = (await rpc('fs.watch', { projectId, paths: [...ESCAPING_DIRS] })) as { watched: number }
    expect(res).toEqual({ watched: 0 })
  })

  it('watches a directory inside the project as usual', async () => {
    await expect(rpc('fs.watch', { projectId, paths: ['sub'] })).resolves.toEqual({ watched: 1 })
  })
})

describe('surface 4 — write destination', () => {
  it('does not move into a folder pointing outside', async () => {
    for (const toDir of ESCAPING_DIRS) {
      await expect(rpc('fs.move', { projectId, from: 'inside.txt', toDir }), toDir).rejects.toThrow(
        /outside the project/i,
      )
    }
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('inside\n')
    expect(readdirSync(outside)).toEqual(['secret.txt'])
  })

  it('does not move a link pointing outside, even the link itself', async () => {
    await expect(rpc('fs.move', { projectId, from: 'leakfile', toDir: 'dst' })).rejects.toThrow(
      /outside the project/i,
    )
    expect(readdirSync(join(root, 'dst'))).toEqual([])
  })

  it('does not create a file in a folder pointing outside', async () => {
    const dataBase64 = Buffer.from('PWNED\n').toString('base64')
    for (const toDir of ESCAPING_DIRS) {
      await expect(
        rpc('fs.importFile', { projectId, toDir, name: 'planted.txt', dataBase64 }),
        toDir,
      ).rejects.toThrow(/outside the project/i)
    }
    expect(readdirSync(outside)).toEqual(['secret.txt'])
    expect(existsSync(join(fixture, 'planted.txt'))).toBe(false)
  })
})

describe('surface 5 — paths passed through to the OS', () => {
  /**
   * Trash, "Reveal in Finder," and "Open in IDE" all pass through this one door (`fs.resolve`).
   * The shell has no concept of a project, so once a path leading outside is produced here, there
   * is no further check downstream.
   */
  it('does not produce an absolute path for a path that points outside', async () => {
    for (const path of [...ESCAPING_FILES, ...ESCAPING_DIRS]) {
      await expect(rpc('fs.resolve', { projectId, path }), path).rejects.toThrow(/outside the project/i)
    }
  })

  it('a file inside the project is passed through as its normalized absolute path', async () => {
    await expect(rpc('fs.resolve', { projectId, path: 'inside.txt' })).resolves.toEqual({
      path: realpathSync(join(root, 'inside.txt')),
    })
  })
})

/**
 * A hard link is **a case this guard cannot answer** — so it is not blocked, and this pins down
 * the fact that it is not blocked.
 *
 * A symbolic link has a target to follow, so it can be labeled "outside." A hard link has no
 * target: the directory entry itself sits inside the project, and it is merely **a different name
 * for the same inode** as the file outside. The rule that the checked string is exactly the string
 * used is already upheld here.
 *
 * The reasoning behind this decision is what happens if link count (`nlink > 1`) is used to
 * reject. Cloning this very repository with `git clone --local` gives 214 of 670 files an nlink of
 * 2 — because git links `.git/objects` with hard links, and pnpm does the same on a filesystem
 * without clonefile. That is a value that would turn a third of an ordinary clone into "files that
 * cannot be opened."
 *
 * So the defense sits elsewhere: sending a hard link to the trash deletes **only the project-side
 * name**, and the outside file remains. `fs.resolve` returning the path inside the project is the
 * proof of that.
 */
describe('hard link — a limit that cannot be answered by path alone', () => {
  it('the path passed to the OS is the name inside the project — trash does not delete the outside file', async () => {
    linkSync(join(outside, 'secret.txt'), join(root, 'hard.txt'))
    await expect(rpc('fs.resolve', { projectId, path: 'hard.txt' })).resolves.toEqual({
      path: join(root, 'hard.txt'),
    })
  })
})
