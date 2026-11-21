/**
 * What the tests of `pnpm pre-pr` (#1181) share: git for the repositories they build, and fakes of its tools (pnpm install, tsc,
 * dependency-cruiser, vitest) that read the worktree they are given.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { NO_GIT_MAINTENANCE } from './git-fixture.test-helpers.js'
// @ts-expect-error — a plain .mjs script, so the board app can start it with Node alone
import { realRunners } from '../scripts/pre-pr.mjs'
// @ts-expect-error — a plain .mjs script, as above
import { canonical } from '../scripts/pre-pr-worktrees.mjs'

/**
 * Much of what these tests do is synchronous work (git, tsc and vitest through `execFileSync`) that holds the worker's event loop,
 * and vitest's worker gives up on the answer to a report after 60 s ("Timeout calling onTaskUpdate", tooling/vitest-stall-watch.ts).
 * On a loaded runner tooling/pre-pr.test.ts hit it with every test passing. Called in a test file, this gives the loop a turn after
 * each test, so a report is answered between tests and not only when the file ends.
 */
export const yieldBetweenTests = () => afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))

/** A new temporary folder, named as the file system names it, as vitest and git name their paths: a Windows runner gives its temporary folder in the 8.3 form */
export const tempDir = (prefix: string): string => canonical(mkdtempSync(join(tmpdir(), prefix)))

// No automatic maintenance: a commit starts a detached `git maintenance run --auto` that holds objects/maintenance.lock after the
// commit returns, and the copy of a template made right then (cpSync) meets the lock vanishing: ENOENT on its .git/objects
export const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_ALL: 'C', ...NO_GIT_MAINTENANCE }
export const gitIn = (env: NodeJS.ProcessEnv, cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env }).trim()
export const git = (cwd: string, ...args: string[]) => gitIn(GIT_ENV, cwd, args)

export type Report = { testResults: { name: string; status?: string; message?: string; assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[] }
export type Pass = { report: Report | null; timedOut: boolean }

/** A vitest JSON report recorded from a real run (tooling/fixtures/pre-pr), with `root` where the recording's checkout was */
export const recordedReport = (name: string, root: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/pre-pr/${name}`, import.meta.url)), 'utf8').replaceAll('<root>', root.split('\\').join('/')))

/**
 * The tools, faked. A fake test file is one line a test: `name :: file :: text`, passing when the file holds the text.
 * `linkTo`: each worktree gets a real link (a junction on Windows) at src/node_modules to that folder,
 * as prepare's links into the checkout's dependencies are, so the clean-up is tested on the real thing.
 */
export function fakeRunners(opts: { orphans?: string[]; cycle?: boolean; lintFails?: boolean; linkTo?: string } = {}) {
  const calls = { prepare: [] as string[], tsc: [] as string[], lint: [] as string[][], vitest: [] as string[][], names: [] as string[][], timeouts: [] as (number | undefined)[], known: [] as (string[] | undefined)[] }
  return {
    calls,
    runners: {
      tier: realRunners.tier,
      prepare: (dir: string) => {
        const sha = git(dir, 'rev-parse', 'HEAD')
        calls.prepare.push(sha)
        if (opts.linkTo) symlinkSync(opts.linkTo, join(dir, 'src', 'node_modules'), 'junction')
      },
      tsc: (dir: string, o?: { timeoutMs?: number }) => {
        calls.timeouts.push(o?.timeoutMs)
        calls.tsc.push(git(dir, 'rev-parse', 'HEAD'))
        return existsSync(join(dir, 'BROKEN')) ? { ok: false, out: 'src/a.ts(1,1): error TS2322: broken' } : { ok: true, out: '' }
      },
      depcruise: () => ({
        summary: {
          violations: [
            ...(opts.orphans ?? []).map((from) => ({ rule: { name: 'no-orphans', severity: 'warn' }, from })),
            ...(opts.cycle ? [{ rule: { name: 'no-circular', severity: 'error' }, from: 'src/a.mjs', to: 'src/b.mjs', cycle: [{ name: 'src/b.mjs' }, { name: 'src/a.mjs' }] }] : []),
            { rule: { name: 'not-to-unresolvable', severity: 'warn' }, from: 'src/x.ts' },
          ],
        },
      }),
      lint: (_dir: string, files: string[]) => {
        calls.lint.push(files)
        return opts.lintFails ? { ok: false, out: 'src/b.mjs\n  1:1  error  Unsafe type assertion  @typescript-eslint/no-unsafe-type-assertion' } : { ok: true, out: '' }
      },
      // The declaration (tooling/guards.ts) is JSON here, `[{ test, tests?, reads? }]`, where the real one is TypeScript that
      // scripts/pre-pr-guards.mjs reads; a guard is changed when the commits change its test or a file it reads
      guards: (dir: string, from: string, to: string) => {
        const file = join(dir, 'tooling', 'guards.ts')
        if (!existsSync(file)) return { guards: null, changed: [] }
        const declared = JSON.parse(readFileSync(file, 'utf8')) as { test: string; tests?: string; reads?: string[] }[]
        const paths = git(dir, 'diff', '--name-only', from, to).split('\n')
        return { guards: declared.map(({ test, tests }) => ({ test, tests })), changed: declared.filter((g) => [g.test, ...(g.reads ?? [])].some((f) => paths.includes(f))).map((g) => g.test) }
      },
      // A line `title :: file :: text` is a test that passes when the file holds the text; a fourth field `skip` makes it a skipped
      // one. With `namesOnly` none runs: every test is named, as skipped. With `known` the run ends at the first passing test not
      // among them, as pre-pr-stop-reporter.mjs ends it: the tests after it are pending. A line `does not load :: <message>` makes
      // the file one that does not load, as the real vitest reports it (a test below checks that)
      vitest: (dir: string, files: string[], o?: { timeoutMs?: number; namesOnly?: boolean; known?: { file: string; name: string }[] }): Pass => {
        calls.timeouts.push(o?.timeoutMs)
        ;(o?.namesOnly ? calls.names : calls.vitest).push(files)
        if (!o?.namesOnly) calls.known.push(o?.known?.map((t) => `${t.file} > ${t.name}`))
        let ended = false
        const unloaded = (file: string) => /^does not load :: (.*)$/m.exec(readFileSync(join(dir, file), 'utf8'))?.[1]
        return {
          timedOut: false,
          report: {
            testResults: files.map((file) => ({
              name: join(dir, file),
              ...(unloaded(file) ? { status: 'failed', message: unloaded(file) } : {}),
              assertionResults: unloaded(file) ? [] : readFileSync(join(dir, file), 'utf8')
                .split('\n')
                .filter((l) => l.includes(' :: '))
                .map((l) => {
                  const [title, target, text, skip] = l.split(' :: ').map((s) => s.trim()) as [string, string, string, string | undefined]
                  const ok = existsSync(join(dir, target)) && readFileSync(join(dir, target), 'utf8').includes(text)
                  const status = ended ? 'pending' : o?.namesOnly || skip ? 'skipped' : ok ? 'passed' : 'failed'
                  if (status === 'passed' && o?.known && !o.known.some((t) => t.file === file && t.name === title)) ended = true
                  return { ancestorTitles: [], title, status }
                }),
            })),
          },
        }
      },
    },
  }
}
