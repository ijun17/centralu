import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SLOW } from './test-timing.js'
// @ts-expect-error — a plain .mjs script, so the board app can start it with Node alone
import { realRunners } from '../scripts/pre-pr.mjs'
// @ts-expect-error — a plain .mjs script, as above
import { mirrorModules, nodeModulesDirs, unlinkLinks } from '../scripts/pre-pr-worktrees.mjs'

/**
 * The worktrees `pnpm pre-pr` checks commits in (scripts/pre-pr-worktrees.mjs): the checkout's dependencies given to a
 * worktree as links, a workspace package pointing at the worktree's own copy so tsc sees one declaration of each class, and
 * the links taken away again without reaching through them.
 */
describe('the dependencies of a pre-pr worktree', () => {
  it('mirrors the checkout\'s dependencies into a worktree with the same lockfile, workspace packages pointing at the worktree, and unlinks them without touching the checkout (#1254)', () => {
    const base = mkdtempSync(join(tmpdir(), 'cc-prepr-deps-'))
    try {
      const root = join(base, 'checkout')
      const tree = join(base, 'worktree')
      for (const dir of ['node_modules/.pnpm', 'node_modules/left-pad', 'packages/ui/node_modules/react', 'packages/ui/node_modules/@cc', 'packages/core/src']) mkdirSync(join(root, dir), { recursive: true })
      for (const dir of ['packages/ui', 'packages/core/src']) mkdirSync(join(tree, dir), { recursive: true })
      writeFileSync(join(root, 'node_modules/left-pad/index.js'), 'keep')
      writeFileSync(join(root, 'node_modules/.modules.yaml'), 'layoutVersion: 5\n')
      // A link to a file: a junction cannot be one, and Windows makes it without a word
      writeFileSync(join(root, 'node_modules/.pnpm/shim.txt'), 'a file')
      let fileLink = true
      try {
        symlinkSync(join(root, 'node_modules/.pnpm/shim.txt'), join(root, 'node_modules/shim.txt'), 'file')
      } catch {
        fileLink = false // Windows without the privilege for a file link
      }
      writeFileSync(join(root, 'packages/ui/node_modules/react/index.js'), 'keep')
      writeFileSync(join(root, 'packages/core/src/x.ts'), 'checkout')
      writeFileSync(join(tree, 'packages/core/src/x.ts'), 'worktree')
      // How pnpm links a workspace package: a link inside a scope folder, to the package's folder
      symlinkSync(join(root, 'packages/core'), join(root, 'packages/ui/node_modules/@cc/core'), 'junction')
      writeFileSync(join(root, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\n')
      writeFileSync(join(tree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\r\n')
      expect(nodeModulesDirs(root)).toEqual(['node_modules', 'packages/ui/node_modules'])
      realRunners.prepare(tree, root)
      expect(readFileSync(join(tree, 'packages/ui/node_modules/react/index.js'), 'utf8')).toBe('keep')
      expect(readFileSync(join(tree, 'node_modules/left-pad/index.js'), 'utf8')).toBe('keep')
      // pnpm's state names the checkout's store: a pnpm install into the worktree would trust it
      expect(existsSync(join(tree, 'node_modules/.modules.yaml'))).toBe(false)
      if (fileLink) expect(readFileSync(join(tree, 'node_modules/shim.txt'), 'utf8')).toBe('a file')
      // The workspace package is the worktree's own, whichever way it is reached: no path back into the checkout
      expect(readFileSync(join(tree, 'packages/ui/node_modules/@cc/core/src/x.ts'), 'utf8')).toBe('worktree')
      expect(realpathSync.native(join(tree, 'packages/ui/node_modules/@cc/core'))).toBe(realpathSync.native(join(tree, 'packages/core')))
      // Everything else leads to the checkout's own dependencies
      expect(realpathSync.native(join(tree, 'packages/ui/node_modules/react'))).toBe(realpathSync.native(join(root, 'packages/ui/node_modules/react')))
      // .pnpm, left-pad, react and @cc/core; the copy of a file is not a link
      expect(unlinkLinks(tree)).toBe(4)
      expect(existsSync(join(tree, 'node_modules/left-pad'))).toBe(false)
      expect(existsSync(join(tree, 'packages/ui/node_modules/@cc/core'))).toBe(false)
      expect(unlinkLinks(tree)).toBe(0)
      // The revert check takes the links away and prepares again, over the folders they leave: all of it back
      realRunners.prepare(tree, root)
      expect(readFileSync(join(tree, 'packages/ui/node_modules/react/index.js'), 'utf8')).toBe('keep')
      expect(readFileSync(join(tree, 'packages/ui/node_modules/@cc/core/src/x.ts'), 'utf8')).toBe('worktree')
      expect(unlinkLinks(tree)).toBe(4)
      rmSync(tree, { recursive: true, force: true })
      expect(readFileSync(join(root, 'node_modules/left-pad/index.js'), 'utf8')).toBe('keep')
      expect(readFileSync(join(root, 'packages/ui/node_modules/react/index.js'), 'utf8')).toBe('keep')
      expect(readFileSync(join(root, 'packages/core/src/x.ts'), 'utf8')).toBe('checkout')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('leaves out a workspace package the worktree does not have, and a node_modules it has no place for', () => {
    const base = mkdtempSync(join(tmpdir(), 'cc-prepr-deps-'))
    try {
      const root = join(base, 'checkout')
      const tree = join(base, 'worktree')
      for (const dir of ['node_modules', 'packages/ui/node_modules/@cc', 'packages/gone', 'packages/old/node_modules/z']) mkdirSync(join(root, dir), { recursive: true })
      mkdirSync(join(tree, 'packages/ui'), { recursive: true })
      symlinkSync(join(root, 'packages/gone'), join(root, 'packages/ui/node_modules/@cc/gone'), 'junction')
      expect(mirrorModules(root, tree)).toBe(2)
      expect(readdirSync(join(tree, 'packages/ui/node_modules/@cc'))).toEqual([])
      expect(existsSync(join(tree, 'packages/old'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  /**
   * The failure itself (#1254): a class declared in the worktree, and the same file reached through the checkout's
   * link to the workspace package. Seen on macOS (/var -> /private/var) and on the Windows runner (a temporary folder
   * named RUNNER~1 on one side, runneradmin on the other); tsc follows the links the same way on Windows here.
   * `reach` is the way the caller names the two folders: tsc must see one spelling of each.
   */
  function typeChecks(prefix: string, reach: (base: string) => { root: string; tree: string }): void {
    const base = mkdtempSync(join(tmpdir(), prefix))
    const { root, tree } = reach(base)
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      const sources: Record<string, string> = {
        'tsconfig.json': JSON.stringify({ compilerOptions: { noEmit: true, strict: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022' }, include: ['packages/*/src'] }),
        'packages/core/package.json': JSON.stringify({ name: '@cc/core', version: '0.0.0', type: 'module', exports: { '.': './src/index.ts' } }),
        'packages/core/src/index.ts': 'export class Clock { private ticks = 0; now() { return this.ticks } }\n',
        // Both ways in, as apps/web does: a package name, and a relative path to the same sources
        'packages/ui/src/index.ts': "import { Clock } from '@cc/core'\nimport { Clock as Same } from '../../core/src/index'\nexport const clock: Same = new Clock()\n",
      }
      for (const dir of [root, tree]) {
        for (const [file, text] of Object.entries(sources)) {
          mkdirSync(dirname(join(dir, file)), { recursive: true })
          writeFileSync(join(dir, file), text)
        }
      }
      mkdirSync(join(root, 'node_modules/.pnpm'), { recursive: true })
      mkdirSync(join(root, 'packages/ui/node_modules/@cc'), { recursive: true })
      symlinkSync(join(here, '..', 'node_modules', 'typescript'), join(root, 'node_modules/typescript'), 'junction')
      symlinkSync(join(root, 'packages/core'), join(root, 'packages/ui/node_modules/@cc/core'), 'junction')
      writeFileSync(join(root, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\n')
      writeFileSync(join(tree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      realRunners.prepare(tree, root)
      const result = realRunners.tsc(tree)
      expect(result.out).toBe('')
      expect(result.ok).toBe(true)
      // And again after the revert check's unlink and prepare: typescript is still there to run
      unlinkLinks(tree)
      realRunners.prepare(tree, root)
      expect(realRunners.tsc(tree)).toEqual({ ok: true, out: '', timedOut: false })
    } finally {
      // Links first: `typescript` in both folders leads into this repository's own node_modules, which no delete may follow
      unlinkLinks(tree)
      unlinkLinks(root)
      rmSync(realpathSync.native(base), { recursive: true, force: true })
    }
  }

  // The temporary folder as the system hands it out: on the Windows runner that is the 8.3 short form, on macOS /var
  const plain = (base: string) => ({ root: join(base, 'checkout'), tree: join(base, 'worktree') })

  it('type-checks a worktree whose workspace package is reached both by path and by name as one declaration', { timeout: 60_000 * SLOW }, () => {
    typeChecks('cc-prepr-tsc-', plain)
  })

  // A folder named by two spellings is two folders to tsc, wherever the second spelling comes from. On Windows a child
  // keeps the spelling of the folder it was started in, so a link to the folder is a second spelling there; elsewhere the
  // system resolves a working folder, and this only shows that a caller's link is harmless
  it('type-checks a worktree and a checkout that the caller names through a link to their folder', { timeout: 60_000 * SLOW }, () => {
    typeChecks('cc-prepr-alias-', (base) => {
      mkdirSync(join(base, 'real'))
      const alias = join(base, 'alias')
      symlinkSync(join(base, 'real'), alias, 'junction')
      mkdirSync(join(alias, 'checkout'))
      mkdirSync(join(alias, 'worktree'))
      return { root: join(alias, 'checkout'), tree: join(alias, 'worktree') }
    })
  })

  // The Windows runner's temporary folder (RUNNER~1 in the user's profile): the same folder in its 8.3 short form
  it.skipIf(process.platform !== 'win32')('type-checks a worktree and a checkout that the caller names in the 8.3 short form of their folder', { timeout: 60_000 * SLOW }, (ctx) => {
    // realpathSync.native writes the long name out (the plain one keeps a short name as it was given)
    const shortOf = (dir: string) => execSync(`for %I in ("${realpathSync.native(dir)}") do @echo %~sI`, { encoding: 'utf8', shell: 'cmd.exe' }).trim()
    const probe = mkdtempSync(join(tmpdir(), 'cc-prepr-probe-'))
    const has83 = shortOf(probe).toLowerCase() !== realpathSync.native(probe).toLowerCase()
    rmSync(probe, { recursive: true })
    // A volume with 8.3 names switched off (a Dev Drive) has none to give
    if (!has83) ctx.skip()
    typeChecks('cc-prepr-short-', (base) => {
      mkdirSync(join(base, 'checkout'))
      mkdirSync(join(base, 'worktree'))
      const short = shortOf(base)
      expect(realpathSync.native(short).toLowerCase()).toBe(realpathSync.native(base).toLowerCase())
      return { root: join(short, 'checkout'), tree: join(short, 'worktree') }
    })
  })
})
