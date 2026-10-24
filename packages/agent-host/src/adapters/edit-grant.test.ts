import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { claudeEditInside, insideFolder } from './edit-grant.js'

/**
 * The `edits` preset's one grant (#1525): where a file edit counts as inside the session's folder. Real folders and a
 * real link, since the point is what the disk says after links are resolved.
 */
let base: string
let folder: string
beforeEach(() => {
  base = tempRoot('edit-grant')
  folder = join(base, 'proj')
  mkdirSync(join(folder, 'src'), { recursive: true })
  mkdirSync(join(base, 'proj-other'))
  mkdirSync(join(base, 'outside'))
  writeFileSync(join(folder, 'src', 'a.ts'), 'a')
})
afterEach(() => removeTree(base))

describe('insideFolder', () => {
  it('accepts an existing file, a new file in an existing folder, and a new file in a folder not made yet', async () => {
    expect(await insideFolder(folder, [join(folder, 'src', 'a.ts')])).toBe(true)
    expect(await insideFolder(folder, [join(folder, 'src', 'new.ts')])).toBe(true)
    expect(await insideFolder(folder, [join(folder, 'deep', 'er', 'new.ts')])).toBe(true)
    expect(await insideFolder(folder, ['src/relative.ts'])).toBe(true)
  })

  it('refuses a path outside the folder: a parent, a sibling that shares the name as a prefix, an absolute path, a `..` path', async () => {
    expect(await insideFolder(folder, [join(base, 'outside', 'x.ts')])).toBe(false)
    expect(await insideFolder(folder, [join(base, 'proj-other', 'x.ts')])).toBe(false)
    expect(await insideFolder(folder, [join(base, 'x.ts')])).toBe(false)
    expect(await insideFolder(folder, ['../outside/x.ts'])).toBe(false)
    expect(await insideFolder(folder, ['src/../../outside/x.ts'])).toBe(false)
    expect(await insideFolder(folder, [folder])).toBe(false)
  })

  it('refuses a link that leaves the folder, for an existing file and for a new one under it', async () => {
    // A junction needs no privilege on Windows and is a plain link elsewhere
    symlinkSync(join(base, 'outside'), join(folder, 'link'), 'junction')
    writeFileSync(join(base, 'outside', 'secret.txt'), 's')
    expect(await insideFolder(folder, [join(folder, 'link', 'secret.txt')])).toBe(false)
    expect(await insideFolder(folder, [join(folder, 'link', 'new.txt')])).toBe(false)
  })

  it('refuses the names that decide what runs or what is allowed, at any depth and in any case', async () => {
    for (const p of ['.git/hooks/pre-commit', '.git/config', '.claude/settings.json', '.codex/config.toml', '.mcp.json', '.vscode/tasks.json', '.husky/pre-commit', '.centralu/x', 'src/.git/config', 'pkg/.Claude/settings.json', '.GIT/config', '.git./config']) {
      expect(await insideFolder(folder, [join(folder, p)]), p).toBe(false)
    }
    expect(await insideFolder(folder, [join(folder, '.gitignore'), join(folder, 'CLAUDE.md'), join(folder, '.github', 'ci.yml')])).toBe(true)
  })

  it('refuses the shell and tool files that decide what runs, node_modules, and a Windows stream of a protected name', async () => {
    for (const p of ['.gitconfig', '.gitmodules', '.githooks/pre-push', '.bashrc', '.zshrc', '.envrc', '.claude.json', 'node_modules/.pnpm/x/index.js', '.mcp.json::$DATA', '.claude::$INDEX_ALLOCATION/settings.json', 'notes.txt:stream']) {
      expect(await insideFolder(folder, [join(folder, p)]), p).toBe(false)
    }
  })

  it('refuses a link whose target does not exist yet: writing through it makes the target, outside the folder', async () => {
    try {
      symlinkSync(join(base, 'outside', 'not-yet.txt'), join(folder, 'dangling'), process.platform === 'win32' ? 'file' : undefined)
    } catch {
      return // Windows without the privilege to make a file link: the case cannot be built there
    }
    expect(await insideFolder(folder, [join(folder, 'dangling')])).toBe(false)
  })

  it('grants nothing in a folder that is the home folder or holds it', async () => {
    expect(await insideFolder(homedir(), [join(homedir(), 'notes.txt')])).toBe(false)
    expect(await insideFolder(dirname(homedir()), [join(dirname(homedir()), 'notes.txt')])).toBe(false)
  })

  it('needs every target inside, and at least one target', async () => {
    expect(await insideFolder(folder, [join(folder, 'src', 'a.ts'), join(base, 'outside', 'x.ts')])).toBe(false)
    expect(await insideFolder(folder, [join(folder, 'src', 'a.ts'), join(folder, '.git', 'config')])).toBe(false)
    expect(await insideFolder(folder, [])).toBe(false)
    expect(await insideFolder(folder, [''])).toBe(false)
  })

  it('refuses when the folder itself is missing', async () => {
    expect(await insideFolder(join(base, 'gone'), [join(base, 'gone', 'a.ts')])).toBe(false)
  })
})

describe('claudeEditInside', () => {
  it('reads the path field of each editing tool, and nothing else is an edit', async () => {
    const f = join(folder, 'src', 'a.ts')
    expect(await claudeEditInside(folder, 'Edit', { file_path: f })).toBe(true)
    expect(await claudeEditInside(folder, 'MultiEdit', { file_path: f })).toBe(true)
    expect(await claudeEditInside(folder, 'Write', { file_path: f })).toBe(true)
    expect(await claudeEditInside(folder, 'NotebookEdit', { notebook_path: join(folder, 'n.ipynb') })).toBe(true)
    expect(await claudeEditInside(folder, 'Edit', {})).toBe(false)
    expect(await claudeEditInside(folder, 'Edit', { file_path: 3 })).toBe(false)
    expect(await claudeEditInside(folder, 'Edit', { notebook_path: f })).toBe(false)
    for (const tool of ['Bash', 'Read', 'Glob', 'Grep', 'mcp__x__edit']) expect(await claudeEditInside(folder, tool, { file_path: f, command: 'rm -rf x' })).toBe(false)
  })
})
