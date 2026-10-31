/**
 * The drift run's second direction (#270): what the latest published tools offer that their adapters have not
 * reviewed, and which of the adapters' limitations may be gone.
 *
 *   pnpm drift:surface                # read, compare, print the report per tool
 *   pnpm drift:surface --record       # rewrite each adapter's surface-baseline.ts from what was read
 *   pnpm drift:surface --file-issue   # and file (or update) one issue per tool that has findings (the weekly job)
 *
 * The other drift checks (#46) ask whether a name the adapter uses is still there, and go red when it is not. This one
 * asks the opposite question, so a finding is not a failure: the issue is the notification, and the run stays green.
 * It goes red only when a surface cannot be read or the issue cannot be filed, since then nothing would be heard.
 *
 * It reads every adapter the registry ships through the contract's `surface` (`adapters/contract/surface.ts`), so a new
 * adapter is watched by filling that in. Nothing here names a tool. What a reading may do is the contract's rule: read
 * versions, schemas, generated bindings, type declarations and `--help`; never start a session or a turn. The npm
 * packages an adapter asks for are installed at @latest into a temp folder, never the workspace (the pins are
 * `pnpm verify`'s); the CLIs are the ones on PATH, which the workflow installs at @latest.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error — plain .mjs, as the other scripts import theirs
import { isMain } from './is-main.mjs'
import { promisify } from 'node:util'
import type { AgentAdapter, SurfaceEnv } from '../packages/agent-host/src/adapters/contract.js'
import { createAdapters } from '../packages/agent-host/src/adapters/registry.js'
import { baselineSource, compareSurface, findingsKey, surfaceReport, type SurfaceFinding } from '../packages/agent-host/src/adapters/surface-drift.js'

const exec = promisify(execFile)
const ADAPTERS = fileURLToPath(new URL('../packages/agent-host/src/adapters/', import.meta.url))

/** Runs `gh` with arguments and, when given, stdin; its stdout */
export type Gh = (args: readonly string[], input?: string) => Promise<string>

export type DriftDeps = {
  adapters: ReadonlyMap<string, Pick<AgentAdapter, 'surface'>>
  env: SurfaceEnv
  record?: boolean
  fileIssue?: boolean
  gh?: Gh
  /** Writes a baseline file (`--record`) */
  write?: (path: string, text: string) => void
  today?: string
  log?: (line: string) => void
}

/** The marker an issue this run filed carries, with the key of the findings it says */
const marker = (tool: string) => `<!-- surface-drift:${tool}`
const keyOf = (findings: readonly SurfaceFinding[]) => createHash('sha256').update(findingsKey(findings)).digest('hex').slice(0, 16)

/**
 * One issue per tool, kept open until someone sorts it: a weekly run that finds the same things again leaves it alone,
 * one that finds different things rewrites it and says so in a comment. Found by the marker in its body, among the
 * open issues, so a closed one (sorted, baseline re-recorded) is never reopened.
 */
async function fileIssue(gh: Gh, tool: string, body: string, key: string, version: string, log: (l: string) => void): Promise<void> {
  const text = `${body}\n\n${marker(tool)} key:${key} -->\n`
  const open = JSON.parse(await gh(['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,body'])) as { number: number; body: string }[]
  const mine = open.find((i) => i.body.includes(marker(tool)))
  if (!mine) {
    const url = (await gh(['issue', 'create', '--title', `Surface drift: ${tool} offers what its adapter has not reviewed`, '--body-file', '-'], text)).trim()
    log(`[surface] ${tool}: filed ${url}`)
    return
  }
  if (mine.body.includes(`key:${key}`)) {
    log(`[surface] ${tool}: #${mine.number} already says this`)
    return
  }
  await gh(['issue', 'edit', String(mine.number), '--body-file', '-'], text)
  await gh(['issue', 'comment', String(mine.number), '--body-file', '-'], `The weekly run read ${version}, and what it finds changed: the description now says what it found.`)
  log(`[surface] ${tool}: updated #${mine.number}`)
}

/** 0 when every surface was read (and every issue filed); 1 when one was not */
export async function runSurfaceDrift(deps: DriftDeps): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l))
  const today = deps.today ?? new Date().toISOString().slice(0, 10)
  let failed = 0
  for (const [tool, adapter] of deps.adapters) {
    const surface = adapter.surface
    if (!surface) {
      log(`[surface] ${tool}: declares no surface, so nothing watches what it offers (adapters/contract/surface.ts)`)
      failed++
      continue
    }
    try {
      const reading = surface.read(await surface.gather(deps.env))
      if (deps.record) {
        const path = join(ADAPTERS, tool, 'surface-baseline.ts')
        ;(deps.write ?? ((p, t) => writeFileSync(p, t)))(path, baselineSource(reading, today))
        log(`[surface] ${tool}: recorded ${reading.version} as the baseline`)
        continue
      }
      const findings = compareSurface(reading, surface.limitations, surface.baseline)
      if (findings.length === 0) {
        log(`[surface] ${tool}: nothing new since ${surface.baseline.version} (read ${reading.version})`)
        continue
      }
      const report = surfaceReport(tool, reading, surface.baseline, findings)
      log(`[surface] ${tool}: ${findings.length} finding(s)\n\n${report}\n`)
      if (deps.fileIssue) await fileIssue(deps.gh ?? gh, tool, report, keyOf(findings), reading.version, log)
    } catch (e) {
      log(`[surface] ${tool}: ${e instanceof Error ? e.message : String(e)}`)
      failed++
    }
  }
  return failed > 0 ? 1 : 0
}

/**
 * npm and the CLIs npm installs are .cmd shims on Windows, which execFile starts only through a shell; their arguments
 * here hold no spaces. gh is an .exe, and its titles and bodies do, so it runs without one.
 */
const run = async (command: string, args: readonly string[], opts: { input?: string; shell?: boolean } = {}): Promise<string> => {
  const shell = opts.shell ?? process.platform === 'win32'
  const child = exec(command, [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, shell })
  if (opts.input !== undefined) child.child.stdin?.end(opts.input)
  return (await child).stdout
}
const gh: Gh = (args, input) => run('gh', args, { input, shell: false })

/** The real environment: npm packages at @latest in one temp folder, the CLIs on PATH */
export function latestEnv(): { env: SurfaceEnv; dispose(): void } {
  const temps: string[] = []
  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'surface-drift-'))
    temps.push(d)
    return d
  }
  const installed = new Map<string, Promise<string>>()
  const env: SurfaceEnv = {
    packageDir(name) {
      let dir = installed.get(name)
      if (!dir) {
        const prefix = tempDir()
        dir = run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', `${name}@latest`]).then(() => join(prefix, 'node_modules', name))
        installed.set(name, dir)
      }
      return dir
    },
    run: (command, args) => run(command, args),
    tempDir,
  }
  return { env, dispose: () => temps.forEach((d) => rmSync(d, { recursive: true, force: true })) }
}

if (isMain(import.meta.url)) {
  const { env, dispose } = latestEnv()
  try {
    process.exitCode = await runSurfaceDrift({
      adapters: createAdapters(),
      env,
      record: process.argv.includes('--record'),
      fileIssue: process.argv.includes('--file-issue'),
    })
  } finally {
    dispose()
  }
}
